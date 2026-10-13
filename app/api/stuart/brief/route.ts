import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { buildBankingEvidence, type CachedBankAccount, type CachedPaymentObservation } from "@/lib/stuart/banking-evidence";
import { buildThirteenWeekForecast, summariseProjectCosts, type StuartCostLine, type StuartForecastInvoice } from "@/lib/stuart/forecast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const service = createServiceRoleClient();
  const { data: connection, error: connectionError } = await service
    .from("xero_connections")
    .select("id,last_sync_completed_at,last_sync_error,scopes")
    .eq("is_active", true)
    .maybeSingle();
  if (connectionError) return NextResponse.json({ error: connectionError.message }, { status: 500 });

  // Cached read only: this branch never calls Xero or starts a sync/review.
  if (request.nextUrl.searchParams.get("response_format") === "banking") {
    const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
    const limit = Number(request.nextUrl.searchParams.get("limit") ?? "5");
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 5) {
      return NextResponse.json({ error: "offset must be a non-negative integer and limit must be 1-5" }, { status: 400 });
    }
    const connectionId = connection?.id ?? "00000000-0000-0000-0000-000000000000";
    const [accounts, payments] = await Promise.all([
      service.from("xero_bank_accounts")
        .select("xero_account_id,name,bank_account_type,status,current_balance,balance_as_of,balance_source,balance_synced_at,synced_at,account_currency_code:raw_json->>CurrencyCode", { count: "exact" })
        .eq("connection_id", connectionId)
        .eq("status", "ACTIVE")
        .in("bank_account_type", ["BANK", "CREDITCARD", "PAYPAL"])
        .order("xero_account_id", { ascending: true })
        .range(offset, offset + limit - 1),
      service.from("xero_payments")
        .select("account_id:raw_json->Account->>AccountID,payment_date,is_reconciled,status,synced_at", { count: "exact" })
        .eq("connection_id", connectionId)
        .order("xero_payment_id", { ascending: true })
        .range(0, 999),
    ]);
    const error = accounts.error ?? payments.error;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(buildBankingEvidence({
      connection,
      accounts: (accounts.data ?? []) as unknown as CachedBankAccount[],
      payments: (payments.data ?? []) as unknown as CachedPaymentObservation[],
      accountTotal: accounts.count ?? 0,
      paymentTotal: payments.count ?? 0,
      offset,
      limit,
    }));
  }

  const [findings, feedback, run, cash, invoices, costLines, projects] = await Promise.all([
    service
      .from("stuart_finance_findings")
      .select("id,finding_key,kind,severity,title,detail,source_type,source_id,evidence,confidence,first_seen_at,last_seen_at")
      .eq("status", "open")
      .order("severity", { ascending: false })
      .order("last_seen_at", { ascending: false })
      .limit(200),
    service
      .from("stuart_aria_feedback")
      .select("id,source_email_id,reason,corrected_route,training_rule,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100),
    service
      .from("stuart_review_runs")
      .select("id,status,started_at,completed_at,finding_count,feedback_count,error_message")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("xero_cash_snapshots")
      .select("cash_balance,credit_balance,as_of_date,synced_at")
      .eq("connection_id", connection?.id ?? "00000000-0000-0000-0000-000000000000")
      .order("as_of_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    connection?.id
      ? service
        .from("xero_invoices")
        .select("invoice_type,status,due_date,amount_due")
        .eq("connection_id", connection.id)
      : Promise.resolve({ data: [] as StuartForecastInvoice[], error: null }),
    service
      .from("cost_lines")
      .select("project_id,cost_ex_gst,quoted_to_client_ex_gst,actual_paid_ex_gst")
      .is("deleted_at", null)
      .limit(5000),
    service
      .from("projects")
      .select("id,name,job_number,status")
      .is("deleted_at", null),
  ]);
  const error = findings.error ?? feedback.error ?? run.error ?? cash.error ?? invoices.error ?? costLines.error ?? projects.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const projectById = new Map((projects.data ?? []).map((project) => [project.id, project]));
  const commercialHistory = summariseProjectCosts((costLines.data ?? []) as StuartCostLine[])
    .map((summary) => ({ ...summary, project: projectById.get(summary.project_id) ?? null }))
    .sort((a, b) => Math.abs(b.actual_vs_estimated_ex_gst) - Math.abs(a.actual_vs_estimated_ex_gst));
  const generatedAt = new Date().toISOString();
  const forecast = buildThirteenWeekForecast(
    cash.data?.cash_balance ?? 0,
    (invoices.data ?? []) as StuartForecastInvoice[],
    generatedAt.slice(0, 10)
  );
  const authority = {
    may: ["observe", "classify", "calculate", "forecast", "reconcile", "flag", "recommend", "prepare handovers", "create draft Xero supplier bills from verified invoices"],
    may_not: ["approve Xero bills", "create a bill from a supplier statement total", "move money", "pay suppliers", "issue refunds", "run payroll", "change bank details", "reconcile bank feeds", "submit tax", "post journals", "delete financial records", "approve final prices"],
  };
  if (request.nextUrl.searchParams.get("response_format") === "concise") {
    const weeks = forecast.weeks;
    const openFindings = findings.data ?? [];
    const conciseFindings = openFindings.slice(0, 10).map((finding) => ({
      finding_key: finding.finding_key,
      kind: finding.kind,
      severity: finding.severity,
      title: finding.title,
      source_id: finding.source_id,
    }));
    const conciseFeedback = (feedback.data ?? []).slice(0, 5).map((item) => ({
      id: item.id,
      source_email_id: item.source_email_id,
      corrected_route: item.corrected_route,
      created_at: item.created_at,
    }));
    return NextResponse.json({
      generated_at: generatedAt,
      cash_snapshot: cash.data,
      cash_forecast_summary: {
        basis: forecast.basis,
        opening_cash: forecast.opening_cash,
        closing_cash_base_week_13: weeks.at(-1)?.closing_cash_base ?? forecast.opening_cash,
        closing_cash_downside_week_13: weeks.at(-1)?.closing_cash_downside ?? forecast.opening_cash,
        minimum_closing_cash_base: Math.min(...weeks.map((week) => week.closing_cash_base)),
        minimum_closing_cash_downside: Math.min(...weeks.map((week) => week.closing_cash_downside)),
      },
      commercial_summary: {
        projects: commercialHistory.length,
        total_actual_ex_gst: commercialHistory.reduce((sum, project) => sum + project.actual_ex_gst, 0),
        projects_over_estimate: commercialHistory.filter((project) => project.actual_vs_estimated_ex_gst > 0).length,
      },
      latest_review: run.data,
      open_findings: conciseFindings,
      open_findings_returned: Math.min(openFindings.length, 10),
      open_findings_total: openFindings.length,
      more_findings_available: openFindings.length > 25,
      aria_feedback: conciseFeedback,
      authority,
    });
  }
  return NextResponse.json({
    generated_at: generatedAt,
    cash_snapshot: cash.data,
    cash_forecast_13_weeks: forecast,
    commercial_history: commercialHistory,
    commercial_history_note: "Actuals are approved supplier costs already allocated to estimate lines; null actuals are not treated as proof of zero cost.",
    latest_review: run.data,
    open_findings: findings.data ?? [],
    aria_feedback: feedback.data ?? [],
    authority,
  });
}
