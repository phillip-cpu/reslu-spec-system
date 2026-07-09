import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { BANK_DETAILS_SETTINGS_KEY, cleanBankDetails } from "@/lib/bank-details";
import type { BankDetailsResponse, InvoiceBankDetails } from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * GET /api/settings/bank-details
 * Admin-only — UNLIKE most app_settings-backed Settings editors in this
 * codebase (export presets, phase templates, etc. are team-visible),
 * bank account details are financial data, so this round gates BOTH
 * GET and PUT to admin (matches this round's brief: "admin-gate all
 * routes (financial)"). Response: { bank_details: InvoiceBankDetails |
 * null } — null means "not yet configured" (no fallback — see
 * lib/bank-details.ts's header comment for why bank numbers are never
 * invented).
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can view bank details" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", BANK_DETAILS_SETTINGS_KEY)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload: BankDetailsResponse = {
    bank_details: (data?.value as InvoiceBankDetails | undefined) ?? null,
  };
  return NextResponse.json(payload);
}

/**
 * PUT /api/settings/bank-details
 * Admin-only. Body: { account_name, bsb, account_number } — all three
 * required together (see lib/bank-details.ts cleanBankDetails(), 400 on
 * a partial/blank submission). Upserts app_settings('invoice_bank_details').
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit bank details" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cleaned = cleanBankDetails(body);
  if (!cleaned) {
    return NextResponse.json(
      { error: "account_name, bsb and account_number are all required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: BANK_DETAILS_SETTINGS_KEY, value: cleaned, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload: BankDetailsResponse = { bank_details: cleaned };
  return NextResponse.json(payload);
}
