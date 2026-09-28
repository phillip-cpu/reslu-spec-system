import assert from "node:assert/strict";
import test from "node:test";
import { requestedXeroScopes, XERO_SCOPES } from "./oauth.ts";

test("default OAuth consent remains byte-for-byte the existing scope list", () => {
  for (const value of [undefined, "false", "TRUE", "1", ""]) {
    assert.deepEqual(requestedXeroScopes({ XERO_CUSTOMER_RECEIPTS_WRITE_CONSENT_ENABLED: value }), [...XERO_SCOPES]);
  }
});
test("separately reviewed opt-in requests granular payment consent without unrelated scopes", () => {
  const scopes = requestedXeroScopes({ XERO_CUSTOMER_RECEIPTS_WRITE_CONSENT_ENABLED: "true" });
  assert.equal(scopes.includes("accounting.payments"), true); assert.equal(scopes.includes("accounting.payments.read"), false);
  assert.equal(scopes.includes("accounting.transactions"), false); assert.equal(scopes.includes("accounting.banktransactions"), false);
  assert.deepEqual(scopes.filter(scope => scope !== "accounting.payments"), XERO_SCOPES.filter(scope => scope !== "accounting.payments.read"));
});
