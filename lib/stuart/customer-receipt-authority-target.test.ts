import assert from "node:assert/strict";
import test from "node:test";
import { deriveActionTarget } from "../aria-authority.ts";
import { CUSTOMER_RECEIPT_TOOL, customerReceiptTarget, type CustomerReceiptPlan } from "./customer-receipt-contract.ts";

test("approval preview and receipt executor derive the same stable remittance target", () => {
  const identity = { tenant_id: "11111111-1111-4111-8111-111111111111", contact_id: "22222222-2222-4222-8222-222222222222", remittance_reference: "rem-001" };
  assert.deepEqual(deriveActionTarget(CUSTOMER_RECEIPT_TOOL, identity, { target_type: "invoice", target_id: "forged" }), {
    target_type: "customer_remittance", target_id: customerReceiptTarget(identity as CustomerReceiptPlan),
  });
  assert.throws(() => deriveActionTarget(CUSTOMER_RECEIPT_TOOL, { ...identity, remittance_reference: "bad ref" }), /Exact customer remittance/);
  assert.throws(() => deriveActionTarget(CUSTOMER_RECEIPT_TOOL, {}), /Exact customer remittance/);
});
