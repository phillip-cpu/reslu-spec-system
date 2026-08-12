import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContractVariationInput } from "./contract-variation-packages.ts";

test("accepts a separate variation package whose milestones equal its value", () => {
  const result = normalizeContractVariationInput({
    label: "Radio Athens · Variation 01",
    amount_inc_gst: 22_000,
    due_days: 7,
    approved_at: "2026-08-12",
    payment_schedule: [
      { label: "Deposit", percentage: 50, amount_inc_gst: 11_000, trigger_type: "contract_signed" },
      { label: "Completion", percentage: 50, amount_inc_gst: 11_000, trigger_type: "manual", milestone_date: "2026-09-30" },
    ],
  });
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.payment_schedule.length, 2);
});

test("rejects a variation schedule that changes the package total", () => {
  const result = normalizeContractVariationInput({
    label: "Variation 01",
    amount_inc_gst: 22_000,
    due_days: 7,
    payment_schedule: [{ label: "Claim", amount_inc_gst: 20_000, trigger_type: "manual" }],
  });
  assert.deepEqual(result, { ok: false, error: "The variation payment schedule must equal the variation value" });
});
