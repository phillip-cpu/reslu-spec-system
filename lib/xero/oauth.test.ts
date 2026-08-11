import assert from "node:assert/strict";
import test from "node:test";
import { XERO_SCOPES } from "./oauth.ts";

test("Xero OAuth requests only the initial read-only accounting scopes", () => {
  const scopes: readonly string[] = XERO_SCOPES;
  assert.equal(scopes.includes("accounting.invoices.read"), true);
  assert.equal(scopes.includes("accounting.payments.read"), true);
  assert.equal(scopes.includes("accounting.invoices"), false);
  assert.equal(scopes.includes("accounting.payments"), false);
  assert.equal(scopes.includes("accounting.transactions"), false);
});
