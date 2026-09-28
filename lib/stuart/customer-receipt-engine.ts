import {
  assertNoExistingReceipt, customerReceiptPayload, providerReceiptKey, RECEIPT_UUID,
  validateCustomerReceiptPlan, verifyCustomerReceiptReadback, verifyReceiptAccount, verifyReceiptInvoice,
  type CustomerReceiptPlan, type XeroRow,
} from "./customer-receipt-contract.ts";

export type ReceiptLineResult = { invoice_id: string; amount_minor: number; state: "not_attempted" | "uncertain" | "verified"; payment_id: string | null; remaining_due_minor: number | null };
export type ReceiptResult = { action_run_id: string; state: "verified" | "partial"; allocations: ReceiptLineResult[]; reconciliation_performed: false; error: string | null; audit_saved: boolean };
export type ReceiptPorts = {
  assertAuthority(): Promise<void>;
  verifySource(): Promise<void>;
  verifyConnection(): Promise<void>;
  getAccount(): Promise<XeroRow>;
  getInvoice(id: string): Promise<XeroRow>;
  getPayments(id: string): Promise<XeroRow[]>;
  getPayment(id: string): Promise<XeroRow>;
  // Reservation is durable and atomic; an existing claim can never be acquired again.
  claim(): Promise<string>;
  checkpoint(actionId: string, lines: ReceiptLineResult[]): Promise<void>;
  createPayment(payload: ReturnType<typeof customerReceiptPayload>, idempotencyKey: string): Promise<XeroRow>;
  finish(result: ReceiptResult): Promise<void>;
};

/** One remittance, sequential receipts. No automatic retries, compensation, or reconciliation. */
export async function executeCustomerReceipts(raw: unknown, ports: ReceiptPorts): Promise<ReceiptResult> {
  const plan: CustomerReceiptPlan = validateCustomerReceiptPlan(raw);
  await ports.assertAuthority();
  await ports.verifySource();
  await ports.verifyConnection();
  verifyReceiptAccount(await ports.getAccount(), plan);
  for (const allocation of plan.allocations) {
    verifyReceiptInvoice(await ports.getInvoice(allocation.invoice_id), plan, allocation);
    assertNoExistingReceipt(await ports.getPayments(allocation.invoice_id), plan, allocation);
  }
  await ports.assertAuthority();
  const actionId = await ports.claim();
  const result: ReceiptResult = { action_run_id: actionId, state: "partial", allocations: plan.allocations.map(allocation => ({ invoice_id: allocation.invoice_id, amount_minor: allocation.amount_minor, state: "not_attempted", payment_id: null, remaining_due_minor: null })), reconciliation_performed: false, error: null, audit_saved: false };
  try {
    for (const [index, allocation] of plan.allocations.entries()) {
      // Check immediately before each write: a long remittance can outlive consent,
      // or a bookkeeper can change an invoice after the initial all-or-nothing preflight.
      await ports.assertAuthority();
      await ports.verifyConnection();
      verifyReceiptAccount(await ports.getAccount(), plan);
      verifyReceiptInvoice(await ports.getInvoice(allocation.invoice_id), plan, allocation);
      assertNoExistingReceipt(await ports.getPayments(allocation.invoice_id), plan, allocation);
      const line = result.allocations[index];
      // Persist uncertainty BEFORE the request. A killed process or lost response
      // must never leave the next worker believing it is safe to issue another PUT.
      line.state = "uncertain";
      await ports.checkpoint(actionId, result.allocations);
      const payment = await ports.createPayment(customerReceiptPayload(plan, allocation), providerReceiptKey(plan, allocation));
      if (typeof payment.PaymentID !== "string" || !RECEIPT_UUID.test(payment.PaymentID) || payment.HasValidationErrors === true) throw new Error("Xero did not confirm a payment identifier; inspect Xero before retrying");
      line.payment_id = payment.PaymentID;
      await ports.checkpoint(actionId, result.allocations);
      verifyCustomerReceiptReadback(await ports.getPayment(payment.PaymentID), plan, allocation, payment.PaymentID);
      verifyReceiptInvoice(await ports.getInvoice(allocation.invoice_id), plan, allocation, true);
      line.state = "verified";
      line.remaining_due_minor = allocation.expected_due_minor - allocation.amount_minor;
      await ports.checkpoint(actionId, result.allocations);
    }
    result.state = "verified";
  } catch (error) {
    result.error = error instanceof Error ? error.message : "Receipt outcome is uncertain; inspect Xero before retrying";
  }
  // An audit failure never causes a second write. Return every known provider ID
  // even if the durable finish fails, so the owner can recover by GET/readback.
  try { await ports.finish({ ...result, audit_saved: true }); result.audit_saved = true; }
  catch { result.state = "partial"; result.error = `${result.error ? `${result.error} ` : ""}The final audit could not be saved; do not repeat this remittance.`; }
  return result;
}
