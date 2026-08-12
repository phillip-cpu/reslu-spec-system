import { createServiceRoleClient } from "@/lib/supabase/server";

export interface SupplierStatementLine {
  invoice_number: string;
  invoice_date?: string;
  total: number;
}

function normaliseInvoiceNumber(value: string): string {
  return value.trim().toLocaleUpperCase("en-AU").replace(/[^A-Z0-9]/g, "");
}

function cents(value: number): number {
  return Math.round(value * 100);
}

export async function reconcileSupplierStatement(input: {
  supplier: string;
  statementDate: string;
  sourceFilename?: string;
  lines: SupplierStatementLine[];
  reviewedBy: string;
}) {
  if (!input.supplier.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(input.statementDate)) {
    throw new Error("supplier and an ISO statement_date are required");
  }
  if (!input.lines.length || input.lines.length > 500) throw new Error("A statement must contain 1 to 500 invoice lines");
  const seen = new Set<string>();
  for (const line of input.lines) {
    const key = normaliseInvoiceNumber(line.invoice_number);
    if (!key || !Number.isFinite(line.total) || line.total < 0) throw new Error("Every statement line needs an invoice number and non-negative total");
    if (seen.has(key)) throw new Error(`Statement repeats invoice number ${line.invoice_number}`);
    seen.add(key);
  }

  const service = createServiceRoleClient();
  const { data: connection, error: connectionError } = await service
    .from("xero_connections")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  if (connectionError || !connection) throw new Error(connectionError?.message ?? "Xero is not connected");
  const { data: xeroRows, error: xeroError } = await service
    .from("xero_invoices")
    .select("xero_invoice_id,invoice_number,contact_name,invoice_date,total,status")
    .eq("connection_id", connection.id)
    .eq("invoice_type", "ACCPAY");
  if (xeroError) throw new Error(xeroError.message);

  const supplier = input.supplier.trim().toLocaleLowerCase("en-AU");
  const relevant = (xeroRows ?? []).filter((row) =>
    String(row.contact_name ?? "").trim().toLocaleLowerCase("en-AU") === supplier &&
    !["DELETED", "VOIDED"].includes(String(row.status ?? ""))
  );
  const byNumber = new Map(relevant.map((row) => [normaliseInvoiceNumber(String(row.invoice_number ?? "")), row]));
  const results = input.lines.map((line) => {
    const match = byNumber.get(normaliseInvoiceNumber(line.invoice_number));
    if (!match) return { ...line, status: "missing_from_xero" as const };
    if (cents(Number(match.total ?? 0)) !== cents(line.total)) {
      return { ...line, status: "total_mismatch" as const, xero_total: Number(match.total ?? 0), xero_invoice_id: match.xero_invoice_id };
    }
    return { ...line, status: "matched" as const, xero_invoice_id: match.xero_invoice_id, xero_status: match.status };
  });
  const missing = results.filter((row) => row.status === "missing_from_xero").length;
  const mismatches = results.filter((row) => row.status === "total_mismatch").length;
  const result = {
    supplier: input.supplier.trim(),
    statement_date: input.statementDate,
    summary: { invoices: results.length, matched: results.length - missing - mismatches, missing, mismatches },
    lines: results,
    authority: "Reconciliation only. No Xero bill, payment, bank transaction or reconciliation was created.",
  };
  const { error: auditError } = await service.from("stuart_supplier_statement_reviews").insert({
    supplier: input.supplier.trim(),
    statement_date: input.statementDate,
    source_filename: input.sourceFilename?.slice(0, 255) || null,
    invoice_count: results.length,
    missing_count: missing,
    mismatch_count: mismatches,
    result,
    reviewed_by: input.reviewedBy,
  });
  if (auditError) throw new Error(auditError.message);
  return result;
}
