import assert from "node:assert/strict";
import test from "node:test";
import {
  DELIVERY_ALLOWANCE_DESCRIPTION,
  deliveryAllowanceLineInput,
  deliveryVariance,
  isDeliveryDescription,
} from "./delivery-costs.ts";

test("recognises ordinary and freight-only supplier delivery lines", () => {
  assert.equal(isDeliveryDescription("Australia Post Delivery"), true);
  assert.equal(isDeliveryDescription("Extra freight charge"), true);
  assert.equal(isDeliveryDescription("Wall mixer trim kit"), false);
});

test("creates a project-only delivery allowance without an FF&E product link", () => {
  const line = deliveryAllowanceLineInput();
  assert.equal(line.description, DELIVERY_ALLOWANCE_DESCRIPTION);
  assert.equal(line.line_kind, "delivery_allowance");
  assert.equal(line.item_id, null);
  assert.equal(line.actual_paid_ex_gst, null);
});

test("delivery variance is allowance minus actual and does not invent missing values", () => {
  assert.equal(deliveryVariance(100, 75.5), 24.5);
  assert.equal(deliveryVariance(100, 125), -25);
  assert.equal(deliveryVariance(null, 25), null);
});
