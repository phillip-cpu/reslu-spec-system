import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { summarizeCreditLiquidity } from "@/lib/finance/liquidity";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { calculateBankSummaryBalance } from "@/lib/xero/bank-summary";
import type {
  FinanceCreditFacility,
  FinanceXeroFacilityAccount,
  SaveFinanceCreditFacilityRequest,
} from "@/types/finance";
import type { XeroReport } from "@/types/xero";

export const runtime = "nodejs";

const VALID_TYPES = new Set(["overdraft", "credit_card", "line_of_credit", "other"]);
const VALID_STATUSES = new Set(["active", "paused", "closed"]);

type XeroAccountRow = {
  id: string;
  xero_account_id: string;
  name: string;
  bank_account_type: string | null;
  account_class: string | null;
  current_balance: number | string | null;
  balance_as_of: string | null;
  balance_source: "bank_summary" | "balance_sheet" | null;
};

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function limitMinor(row: Record<string, unknown>): number {
  const limit = Number(row.credit_limit_minor);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error(`${String(row.id)} has an invalid facility balance`);
  }
  return limit;
}

function xeroAccountsWithBalances(input: {
  rows: XeroAccountRow[];
  report: XeroReport | null;
  asOfDate: string | null;
}): FinanceXeroFacilityAccount[] {
  const balances = input.report
    ? calculateBankSummaryBalance(
        input.report,
        input.rows.map((row) => ({ name: row.name, bankAccountType: row.bank_account_type }))
      ).accountBalances
    : [];
  const balanceByName = new Map(
    balances.map((balance) => [normaliseName(balance.name), balance.closingBalance])
  );
  return input.rows.filter((row) => {
    const bankType = row.bank_account_type?.toUpperCase();
    return bankType === "BANK" || bankType === "CREDITCARD" ||
      (row.account_class?.toUpperCase() === "LIABILITY" && /(credit|loan|finance|overdraft|facility|line)/i.test(row.name));
  }).map((row) => {
    const bankReportBalance = balanceByName.get(normaliseName(row.name));
    const rawBalance = bankReportBalance ?? (row.current_balance === null ? null : Number(row.current_balance));
    const balanceMinor = rawBalance === null ? null : Math.round(rawBalance * 100);
    if (balanceMinor !== null && !Number.isSafeInteger(balanceMinor)) {
      throw new Error(`${row.name} has an invalid Xero balance`);
    }
    const bankType = row.bank_account_type?.toUpperCase();
    return {
      id: row.id,
      xero_account_id: row.xero_account_id,
      name: row.name,
      bank_account_type: bankType === "BANK" || bankType === "CREDITCARD" ? bankType : "LIABILITY",
      balance_minor: balanceMinor,
      balance_as_of: bankReportBalance === undefined ? row.balance_as_of : input.asOfDate,
      balance_source: bankReportBalance === undefined ? row.balance_source : "bank_summary",
    };
  });
}

async function financeUser() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  return { supabase, user };
}

export async function GET() {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  const [view, edit] = await Promise.all([
    hasFinanceCapability(supabase, "finance.view_company"),
    hasFinanceCapability(supabase, "finance.edit_forecast"),
  ]);
  if (view.error ?? edit.error) return NextResponse.json({ error: view.error ?? edit.error }, { status: 500 });
  if (!view.allowed && !edit.allowed) return NextResponse.json({ error: "Credit facility access denied" }, { status: 403 });

  const { data, error } = await supabase
    .from("finance_credit_facilities")
    .select("*")
    .neq("status", "closed")
    .order("status")
    .order("name");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    const service = createServiceRoleClient();
    const { data: connection, error: connectionError } = await service
      .from("xero_connections")
      .select("id")
      .eq("is_active", true)
      .maybeSingle();
    if (connectionError) return NextResponse.json({ error: connectionError.message }, { status: 500 });
    const [cashResult, accountResult] = connection
      ? await Promise.all([
          service
            .from("xero_cash_snapshots")
            .select("as_of_date,raw_json")
            .eq("connection_id", connection.id)
            .order("as_of_date", { ascending: false })
            .limit(1)
            .maybeSingle(),
          service
            .from("xero_bank_accounts")
            .select("id,xero_account_id,name,bank_account_type,account_class,current_balance,balance_as_of,balance_source")
            .eq("connection_id", connection.id)
            .eq("status", "ACTIVE")
            .order("name"),
        ])
      : [{ data: null, error: null }, { data: [], error: null }];
    const xeroError = cashResult.error ?? accountResult.error;
    if (xeroError) return NextResponse.json({ error: xeroError.message }, { status: 500 });
    const snapshotRaw = cashResult.data?.raw_json as { report?: XeroReport } | null;
    const xeroAccounts = xeroAccountsWithBalances({
      rows: (accountResult.data ?? []) as XeroAccountRow[],
      report: snapshotRaw?.report ?? null,
      asOfDate: cashResult.data?.as_of_date ?? null,
    });
    const accountById = new Map(xeroAccounts.map((account) => [account.id, account]));
    const facilities = ((data ?? []) as Record<string, unknown>[]).map((row): FinanceCreditFacility => {
      const account = accountById.get(String(row.xero_bank_account_id ?? ""));
      if (!account) throw new Error(`${String(row.name)} is not linked to an active Xero bank account`);
      const itemCredit = summarizeCreditLiquidity({
        facilities: [{
          facility_type: row.facility_type as FinanceCreditFacility["facility_type"],
          credit_limit_minor: limitMinor(row),
          xero_bank_account_type: account.bank_account_type,
          xero_balance_minor: account.balance_minor,
          xero_balance_source: account.balance_source,
        }],
      });
      return {
        ...row,
        credit_limit_minor: limitMinor(row),
        xero_bank_account_id: account.id,
        xero_account_name: account.name,
        xero_bank_account_type: account.bank_account_type,
        xero_balance_minor: account.balance_minor,
        xero_balance_as_of: account.balance_as_of,
        xero_balance_source: account.balance_source,
        available_credit_minor: itemCredit.availableCreditMinor,
      } as FinanceCreditFacility;
    });
    const active = facilities.filter((item) => item.status === "active");
    const credit = summarizeCreditLiquidity({
      facilities: active.map((item) => ({
        facility_type: item.facility_type,
        credit_limit_minor: item.credit_limit_minor,
        xero_bank_account_type: item.xero_bank_account_type,
        xero_balance_minor: item.xero_balance_minor,
        xero_balance_source: item.xero_balance_source,
      })),
    });
    return NextResponse.json({
      facilities,
      xero_accounts: xeroAccounts,
      can_edit: edit.allowed,
      summary: {
        credit_limit_minor: credit.creditLimitMinor,
        current_balance_minor: credit.creditDrawnMinor,
        available_credit_minor: credit.availableCreditMinor,
        active_count: active.length,
        xero_balance_as_of: cashResult.data?.as_of_date ?? null,
      },
    });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Could not read credit facilities" }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  const { supabase, user } = await financeUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!financeFoundationEnabled()) return NextResponse.json({ error: "Finance foundation is not enabled" }, { status: 404 });
  const permission = await hasFinanceCapability(supabase, "finance.edit_forecast");
  if (permission.error) return NextResponse.json({ error: permission.error }, { status: 500 });
  if (!permission.allowed) return NextResponse.json({ error: "Credit facility edit denied" }, { status: 403 });

  const body = (await request.json()) as SaveFinanceCreditFacilityRequest;
  if (!body.xero_bank_account_id || !body.reason?.trim()) return NextResponse.json({ error: "Xero account and change reason are required" }, { status: 400 });
  if (!VALID_TYPES.has(body.facility_type) || !VALID_STATUSES.has(body.status)) return NextResponse.json({ error: "Facility type or status is invalid" }, { status: 400 });
  if (!Number.isSafeInteger(body.credit_limit_minor) || body.credit_limit_minor <= 0) {
    return NextResponse.json({ error: "Limit must be a positive minor-unit integer" }, { status: 400 });
  }
  if (body.interest_rate_bps !== null && body.interest_rate_bps !== undefined && (!Number.isInteger(body.interest_rate_bps) || body.interest_rate_bps < 0 || body.interest_rate_bps > 100000)) {
    return NextResponse.json({ error: "Interest rate must be between 0 and 1,000%" }, { status: 400 });
  }

  const service = createServiceRoleClient();
  const { data: xeroAccount, error: xeroError } = await service
    .from("xero_bank_accounts")
    .select("id,name,bank_account_type,account_class,status")
    .eq("id", body.xero_bank_account_id)
    .maybeSingle();
  if (xeroError) return NextResponse.json({ error: xeroError.message }, { status: 500 });
  const isLiability = xeroAccount?.account_class === "LIABILITY";
  if (!xeroAccount || xeroAccount.status !== "ACTIVE" || (!["BANK", "CREDITCARD"].includes(xeroAccount.bank_account_type ?? "") && !isLiability)) {
    return NextResponse.json({ error: "Choose an active Xero facility account" }, { status: 400 });
  }
  const facilityType = xeroAccount.bank_account_type === "CREDITCARD"
    ? "credit_card"
    : body.facility_type;
  if (facilityType === "credit_card" && xeroAccount.bank_account_type !== "CREDITCARD") {
    return NextResponse.json({ error: "Choose overdraft or line of credit for a Xero bank account" }, { status: 400 });
  }

  const { data, error } = await supabase.rpc("save_finance_credit_facility", {
    p_id: body.id ?? null,
    p_name: xeroAccount.name,
    p_provider: body.provider ?? null,
    p_facility_type: facilityType,
    p_credit_limit_minor: body.credit_limit_minor,
    p_current_balance_minor: 0,
    p_interest_rate_bps: body.interest_rate_bps ?? null,
    p_status: body.status,
    p_notes: body.notes ?? null,
    p_expected_version: body.expected_version ?? null,
    p_reason: body.reason,
    p_xero_bank_account_id: body.xero_bank_account_id,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  try {
    return NextResponse.json({ facility: data });
  } catch (caught) {
    return NextResponse.json({ error: caught instanceof Error ? caught.message : "Could not save credit facility" }, { status: 422 });
  }
}
