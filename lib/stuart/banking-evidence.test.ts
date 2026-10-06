import assert from "node:assert/strict";
import test from "node:test";
import { buildBankingEvidence, type CachedBankAccount, type CachedPaymentObservation } from "./banking-evidence.ts";

const account: CachedBankAccount = {
  xero_account_id: "bank-one", name: "Operating", bank_account_type: "BANK", status: "ACTIVE",
  current_balance: "123.45", balance_as_of: "2026-10-06", balance_source: "bank_summary",
  balance_synced_at: "2026-10-06T20:00:34Z", synced_at: "2026-10-06T20:00:34Z",
};
const payment: CachedPaymentObservation = {
  account_id: "bank-one", payment_date: "2026-10-03", is_reconciled: true,
  status: "AUTHORISED", synced_at: "2026-10-06T20:00:34Z",
};
const input = {
  connection: { last_sync_completed_at: "2026-10-06T20:00:34Z", last_sync_error: null,
    scopes: ["accounting.settings.read", "accounting.reports.banksummary.read", "accounting.payments.read"] },
  accounts: [account], payments: [payment], accountTotal: 1, paymentTotal: 1, offset: 0, limit: 5,
};

test("fresh cache and reconciled payments cannot certify bank feed or account reconciliation", () => {
  const result = buildBankingEvidence(input);
  assert.equal(result.accounts[0].ledger_balance.amount_decimal, "123.45");
  assert.equal(result.accounts[0].payment_observations.reconciled_true_count, 1);
  for (const field of ["statement_balance", "last_bank_feed_success_at", "bank_feed_error",
    "unreconciled_statement_line_count", "last_account_reconciled_at"] as const) {
    assert.equal(result.accounts[0][field], null);
  }
  assert.equal(result.bank_transactions_read_scope_granted, false);
  assert.equal(result.bank_transactions_imported, false);
});

test("missing balance is preserved, while an actual zero is available", () => {
  const result = buildBankingEvidence({ ...input, accounts: [
    { ...account, current_balance: null }, { ...account, xero_account_id: "zero", current_balance: "0.00" },
    { ...account, xero_account_id: "invalid", current_balance: "invalid" },
  ], accountTotal: 3 });
  assert.equal(result.accounts[0].ledger_balance.availability, "missing_from_cache");
  assert.equal(result.accounts[0].ledger_balance.amount_decimal, null);
  assert.equal(result.accounts[1].ledger_balance.amount_decimal, "0.00");
  assert.equal(result.accounts[1].ledger_balance.availability, "cached_report_balance");
  assert.equal(result.accounts[2].ledger_balance.amount_decimal, null);
});

test("payment evidence uses exact account IDs and separates false, unknown and deleted", () => {
  const result = buildBankingEvidence({ ...input, payments: [payment,
    { ...payment, is_reconciled: false }, { ...payment, is_reconciled: null },
    { ...payment, account_id: "other", is_reconciled: false },
    { ...payment, account_id: null, is_reconciled: false },
    { ...payment, status: "DELETED", is_reconciled: false },
  ], paymentTotal: 6 });
  assert.deepEqual(result.accounts[0].payment_observations, {
    coverage: "cached_authorised_payments_only", observed_count: 3, reconciled_true_count: 1,
    reconciled_false_count: 1, reconciliation_unknown_count: 1, latest_payment_date: "2026-10-03",
    retrieved_at: "2026-10-06T20:00:34Z",
  });
  assert.equal(result.payment_population.unassigned_authorised_rows, 1);
});

test("partial population and account pagination stay explicit", () => {
  const result = buildBankingEvidence({ ...input, paymentTotal: 1001, accountTotal: 26 });
  assert.equal(result.payment_population.complete, false);
  assert.equal(result.accounts[0].payment_observations.coverage, "partial_cached_authorised_payments_only");
  assert.equal(result.has_more_accounts, true);
});

test("projection drops secrets and raw account data", () => {
  const enriched = { ...account, raw_json: { BankAccountNumber: "DO_NOT_RETURN" }, secret: "DO_NOT_RETURN" };
  assert.equal(JSON.stringify(buildBankingEvidence({ ...input, accounts: [enriched] })).includes("DO_NOT_RETURN"), false);
  assert.equal(buildBankingEvidence({ ...input, connection: null }).connected, false);
});


test("a bounded five-account page fits the MCP response cap", () => {
  const result = buildBankingEvidence({ ...input, accounts: Array.from({ length: 5 }, (_, i) => ({
    ...account, xero_account_id: `account-${i}`, name: "x".repeat(400),
  })), accountTotal: 10 });
  assert.ok(JSON.stringify(result).length < 8000);
});
