import test from "node:test";
import assert from "node:assert/strict";
import { inferSingleExpenseAccountCode } from "./account-code.ts";

test("infers one stable Xero expense code from exact supplier history", () => {
  assert.equal(inferSingleExpenseAccountCode([
    { contact_name: "Supplier Co", raw_json: { LineItems: [{ AccountCode: "310" }, { AccountCode: "310" }] } },
    { contact_name: "Other", raw_json: { LineItems: [{ AccountCode: "999" }] } },
  ], "supplier co"), "310");
});

test("fails closed when supplier history uses multiple account codes", () => {
  assert.equal(inferSingleExpenseAccountCode([
    { contact_name: "Supplier Co", raw_json: { LineItems: [{ AccountCode: "310" }, { AccountCode: "420" }] } },
  ], "Supplier Co"), null);
});
