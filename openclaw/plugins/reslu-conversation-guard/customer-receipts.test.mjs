import assert from "node:assert/strict";
import test from "node:test";
import { evaluateResluConversationTool } from "./policy.mjs";

const context = { sessionKey: "agent:stuart:reslu-conversation-v2-receipt-test" };
const names = ["reslu-stuart__record_stuart_xero_customer_receipts", "mcp__reslu_stuart__record_stuart_xero_customer_receipts", "reslu-stuart__prepare_stuart_xero_customer_receipts", "mcp__reslu_stuart__prepare_stuart_xero_customer_receipts"];
const state = mode => ({ mode, workspaceDir: "/tmp/receipt-test" });

test("separate preparation activation keeps recording and untrusted contexts blocked", () => {
  const config = { enableStuartCustomerReceiptPreparation: true };
  for (const toolName of names) {
    const allowed = toolName.endsWith("__prepare_stuart_xero_customer_receipts");
    assert.equal(evaluateResluConversationTool({ toolName }, context, state("human_request"), config)?.block !== true, allowed);
    for (const mode of ["forwarded_context", "attachment_review", "specialist_consultation", "unknown"]) {
      assert.equal(evaluateResluConversationTool({ toolName }, context, state(mode), config)?.block, true);
    }
  }
});

test("both receipt aliases require trusted explicit activation and a validated human request", () => {
  for (const toolName of names) {
    const event = { toolName, params: { enableStuartCustomerReceipts: true } };
    assert.equal(evaluateResluConversationTool(event, context, state("human_request"))?.block, true);
    assert.equal(evaluateResluConversationTool(event, context, { ...state("human_request"), enableStuartCustomerReceipts: true })?.block, true);
    for (const value of [false, "true", 1, null]) {
      assert.equal(evaluateResluConversationTool(event, context, state("human_request"), { enableStuartCustomerReceipts: value })?.block, true);
    }
    assert.equal(evaluateResluConversationTool(event, context, state("human_request"), { enableStuartCustomerReceipts: true }), undefined);
  }
});

test("activation never admits forwarded content, attachments, specialists or unvalidated envelopes", () => {
  for (const toolName of names) {
    for (const mode of ["forwarded_context", "attachment_review", "specialist_consultation", "unknown"]) {
      assert.equal(evaluateResluConversationTool({ toolName }, context, state(mode), { enableStuartCustomerReceipts: true })?.block, true);
    }
    assert.equal(evaluateResluConversationTool({ toolName }, context, null, { enableStuartCustomerReceipts: true })?.block, true);
  }
});

test("receipt activation does not enable other financial, arbitrary Stuart or host tools", () => {
  for (const toolName of ["reslu-stuart__pay_supplier", "reslu-stuart__approve_xero_bill", "reslu-stuart__record_arbitrary_receipts", "mcp__reslu_stuart__record_arbitrary_receipts", "reslu-stuart__reconcile_bank_line", "exec", "write", "read"]) {
    assert.equal(evaluateResluConversationTool({ toolName }, context, state("human_request"), { enableStuartCustomerReceipts: true })?.block, true);
  }
});
