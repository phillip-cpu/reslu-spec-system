import assert from "node:assert/strict";
import test from "node:test";
import { createCustomerReceiptTool, createCustomerReceiptPreparationTool, customerReceiptToolEnabled, CUSTOMER_RECEIPT_TOOL } from "./customer-receipts.mjs";

test("customer receipts are hidden unless explicitly enabled for Stuart", () => {
  for (const role of ["aria", "marco", "", undefined]) {
    assert.equal(customerReceiptToolEnabled(role, "true"), false);
  }
  for (const flag of [undefined, "", "false", "1", true, "TRUE"]) {
    assert.equal(customerReceiptToolEnabled("stuart", flag), false);
  }
  assert.equal(customerReceiptToolEnabled("stuart", "true"), true);
});

test("receipt connector preserves the exact approved payload and forwards only to its purpose-built route", async () => {
  const calls = [];
  const tool = createCustomerReceiptTool(async (...args) => { calls.push(args); return { outcome: "partial" }; });
  const body = { source_sha256: "a".repeat(64), allocations: [{ amount_minor: 12345 }], _authority: { approval_receipt_id: "exact-receipt" } };
  assert.equal(tool.name, CUSTOMER_RECEIPT_TOOL);
  assert.deepEqual(await tool.handler(body), { outcome: "partial" });
  assert.deepEqual(calls, [["/api/stuart/xero-customer-receipts", { method: "POST", body: JSON.stringify(body) }]]);
  assert.equal(tool.inputSchema.additionalProperties, false);
  assert.equal(tool.inputSchema.properties.allocations.items.additionalProperties, false);
  assert.equal(tool.inputSchema.properties._authority.required.includes("approval_receipt_id"), true);
  assert.equal(tool.inputSchema.properties._authority.required.includes("expected_version"), true);
  assert.equal(tool.inputSchema.properties._authority.properties.expected_absent.const, false);
});

test("connector never automatically repeats an uncertain provider operation", async () => {
  let calls = 0;
  const tool = createCustomerReceiptTool(async () => { calls += 1; throw new Error("Receipt outcome is uncertain"); });
  await assert.rejects(() => tool.handler({}), /uncertain/);
  assert.equal(calls, 1);
});

test("preparation returns an unapproved plan without invoking the recording endpoint", async () => {
  const calls = [];
  const result = { proposed_plan: { money_received_confirmed: false, source_reviewed_confirmed: false } };
  const tool = createCustomerReceiptPreparationTool(async (...args) => { calls.push(args); return result; });
  const body = { customer_name: "Example", allocations: [{ invoice_number: "INV-1", amount_minor: 12500 }] };
  assert.deepEqual(await tool.handler(body), result);
  assert.deepEqual(calls, [["/api/stuart/xero-customer-receipts/prepare", { method: "POST", body: JSON.stringify(body) }]]);
  assert.equal(tool.inputSchema.properties.allocations.maxItems, 20);
  assert.equal("money_received_confirmed" in tool.inputSchema.properties, false);
  assert.equal("_authority" in tool.inputSchema.properties, false);
});
