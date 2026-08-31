import assert from "node:assert/strict";
import test from "node:test";
import { XERO_SCOPES } from "./oauth.ts";

test("Xero OAuth requests only the bounded writes Stuart needs", () => {
  const scopes: readonly string[] = XERO_SCOPES;
  assert.equal(scopes.includes("accounting.invoices"), true);
  assert.equal(scopes.includes("accounting.payments.read"), true);
  assert.equal(scopes.includes("accounting.settings.read"), true);
  assert.equal(scopes.includes("accounting.reports.profitandloss.read"), true);
  assert.equal(scopes.includes("accounting.reports.balancesheet.read"), true);
  assert.equal(scopes.includes("accounting.reports.trialbalance.read"), true);
  assert.equal(scopes.includes("accounting.reports.banksummary.read"), true);
  assert.equal(scopes.includes("accounting.reports.budgetsummary.read"), true);
  assert.equal(scopes.includes("accounting.reports.executivesummary.read"), true);
  assert.equal(scopes.includes("accounting.reports.taxreports.read"), true);
  assert.equal(scopes.includes("accounting.contacts"), true);
  assert.equal(scopes.includes("accounting.contacts.read"), false);
  assert.equal(scopes.includes("accounting.payments"), false);
  assert.equal(scopes.includes("accounting.transactions"), false);
  assert.equal(scopes.includes("accounting.reports.read"), false);
});
