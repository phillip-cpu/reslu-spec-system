import { createServiceRoleClient } from "@/lib/supabase/server";
import { getActiveXeroConnection, xeroGet } from "@/lib/xero/client";
import { xeroDate, xeroTimestamp } from "@/lib/xero/normalise";
import { calculateBankSummaryBalance } from "@/lib/xero/bank-summary";
import { pullXeroReport } from "@/lib/xero/reports";
import type { XeroSyncResult } from "@/types/xero";

type XeroRecord = Record<string, unknown>;

function numberOrNull(value: unknown): number | null {
  const parsed = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(parsed)
    ? null
    : parsed;
}

function invoiceRow(connectionId: string, invoice: XeroRecord) {
  const contact = (invoice.Contact ?? {}) as XeroRecord;
  return {
    connection_id: connectionId,
    xero_invoice_id: String(invoice.InvoiceID ?? ""),
    invoice_type: String(invoice.Type ?? ""),
    status: String(invoice.Status ?? "UNKNOWN"),
    invoice_number: typeof invoice.InvoiceNumber === "string" ? invoice.InvoiceNumber : null,
    reference: typeof invoice.Reference === "string" ? invoice.Reference : null,
    contact_id: typeof contact.ContactID === "string" ? contact.ContactID : null,
    contact_name: typeof contact.Name === "string" ? contact.Name : null,
    invoice_date: xeroDate(invoice.DateString ?? invoice.Date),
    due_date: xeroDate(invoice.DueDateString ?? invoice.DueDate),
    currency_code: typeof invoice.CurrencyCode === "string" ? invoice.CurrencyCode : null,
    subtotal: numberOrNull(invoice.SubTotal),
    total_tax: numberOrNull(invoice.TotalTax),
    total: numberOrNull(invoice.Total),
    amount_due: numberOrNull(invoice.AmountDue),
    amount_paid: numberOrNull(invoice.AmountPaid),
    amount_credited: numberOrNull(invoice.AmountCredited),
    updated_date_utc: xeroTimestamp(invoice),
    raw_json: invoice,
    synced_at: new Date().toISOString(),
  };
}

function paymentRow(connectionId: string, payment: XeroRecord) {
  const invoice = (payment.Invoice ?? {}) as XeroRecord;
  return {
    connection_id: connectionId,
    xero_payment_id: String(payment.PaymentID ?? ""),
    xero_invoice_id: typeof invoice.InvoiceID === "string" ? invoice.InvoiceID : null,
    payment_type: typeof payment.PaymentType === "string" ? payment.PaymentType : null,
    status: typeof payment.Status === "string" ? payment.Status : null,
    payment_date: xeroDate(payment.Date),
    amount: numberOrNull(payment.Amount),
    bank_amount: numberOrNull(payment.BankAmount),
    currency_rate: numberOrNull(payment.CurrencyRate),
    is_reconciled: typeof payment.IsReconciled === "boolean" ? payment.IsReconciled : null,
    updated_date_utc: xeroTimestamp(payment),
    raw_json: payment,
    synced_at: new Date().toISOString(),
  };
}

function accountRow(connectionId: string, account: XeroRecord) {
  return {
    connection_id: connectionId,
    xero_account_id: String(account.AccountID ?? ""),
    code: typeof account.Code === "string" ? account.Code : null,
    name: String(account.Name ?? "Unnamed account"),
    bank_account_type: typeof account.BankAccountType === "string" ? account.BankAccountType : null,
    status: typeof account.Status === "string" ? account.Status : null,
    raw_json: account,
    synced_at: new Date().toISOString(),
  };
}

async function fetchAll(
  connection: NonNullable<Awaited<ReturnType<typeof getActiveXeroConnection>>>,
  endpoint: "Invoices" | "Payments",
  key: "Invoices" | "Payments"
): Promise<XeroRecord[]> {
  const records: XeroRecord[] = [];
  for (let page = 1; page <= 100; page += 1) {
    const body = await xeroGet<Record<string, XeroRecord[]>>(
      connection,
      `api.xro/2.0/${endpoint}`,
      { page: String(page) }
    );
    const batch = Array.isArray(body[key]) ? body[key] : [];
    records.push(...batch);
    if (batch.length < 100) break;
  }
  return records;
}

export async function syncXeroReadModel(triggeredBy: string): Promise<XeroSyncResult> {
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");
  if (!connection.scopes.includes("accounting.settings.read")) {
    throw new Error("Reconnect Xero once to grant read-only bank account access");
  }
  const service = createServiceRoleClient();
  const startedAt = new Date().toISOString();
  const { data: run, error: runError } = await service
    .from("xero_sync_runs")
    .insert({ connection_id: connection.id, triggered_by: triggeredBy, status: "running", started_at: startedAt })
    .select("id")
    .single();
  if (runError || !run) throw new Error(runError?.message ?? "Could not start Xero sync audit");
  await service
    .from("xero_connections")
    .update({ last_sync_started_at: startedAt, last_sync_error: null })
    .eq("id", connection.id);

  try {
    const today = new Date().toISOString().slice(0, 10);
    const [invoices, payments, accountBody, bankSummary] = await Promise.all([
      fetchAll(connection, "Invoices", "Invoices"),
      fetchAll(connection, "Payments", "Payments"),
      xeroGet<{ Accounts?: XeroRecord[] }>(connection, "api.xro/2.0/Accounts"),
      pullXeroReport({ report: "bank_summary", fromDate: today, toDate: today }),
    ]);
    const invoiceRows = invoices
      .filter((row) => row.InvoiceID && (row.Type === "ACCREC" || row.Type === "ACCPAY"))
      .map((row) => invoiceRow(connection.id, row));
    const paymentRows = payments
      .filter((row) => row.PaymentID)
      .map((row) => paymentRow(connection.id, row));
    const accountRows = (accountBody.Accounts ?? [])
      .filter((row) => row.AccountID && row.Name)
      .map((row) => accountRow(connection.id, row));
    const report = bankSummary.reports[0];
    if (!report) throw new Error("Xero Bank Summary returned no report");
    const cash = calculateBankSummaryBalance(
      report,
      accountRows.map((row) => ({ name: row.name, bankAccountType: row.bank_account_type }))
    );

    for (let index = 0; index < invoiceRows.length; index += 500) {
      const { error } = await service
        .from("xero_invoices")
        .upsert(invoiceRows.slice(index, index + 500), { onConflict: "connection_id,xero_invoice_id" });
      if (error) throw new Error(error.message);
    }
    for (let index = 0; index < paymentRows.length; index += 500) {
      const { error } = await service
        .from("xero_payments")
        .upsert(paymentRows.slice(index, index + 500), { onConflict: "connection_id,xero_payment_id" });
      if (error) throw new Error(error.message);
    }
    for (let index = 0; index < accountRows.length; index += 500) {
      const { error } = await service
        .from("xero_bank_accounts")
        .upsert(accountRows.slice(index, index + 500), { onConflict: "connection_id,xero_account_id" });
      if (error) throw new Error(error.message);
    }
    const { error: cashError } = await service.from("xero_cash_snapshots").upsert({
      connection_id: connection.id,
      as_of_date: today,
      cash_balance: cash.cashBalance,
      credit_balance: cash.creditBalance,
      report_date: report.ReportDate ?? null,
      raw_json: {
        report,
        classification: {
          cash_account_count: cash.cashAccountCount,
          credit_account_count: cash.creditAccountCount,
          unmatched_account_count: cash.unmatchedAccountCount,
        },
      },
      synced_at: new Date().toISOString(),
    }, { onConflict: "connection_id,as_of_date" });
    if (cashError) throw new Error(cashError.message);

    const completedAt = new Date().toISOString();
    await Promise.all([
      service.from("xero_sync_runs").update({
        status: "completed",
        completed_at: completedAt,
        invoices_checked: invoiceRows.length,
        payments_checked: paymentRows.length,
      }).eq("id", run.id),
      service.from("xero_connections").update({
        last_sync_completed_at: completedAt,
        last_sync_error: null,
      }).eq("id", connection.id),
    ]);
    return {
      invoices_checked: invoiceRows.length,
      payments_checked: paymentRows.length,
      bank_accounts_checked: accountRows.length,
      cash_balance: cash.cashBalance,
      cash_balance_as_of: today,
      completed_at: completedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Xero sync failed";
    const completedAt = new Date().toISOString();
    await Promise.all([
      service.from("xero_sync_runs").update({ status: "failed", completed_at: completedAt, error_message: message }).eq("id", run.id),
      service.from("xero_connections").update({ last_sync_error: message }).eq("id", connection.id),
    ]);
    throw error;
  }
}
