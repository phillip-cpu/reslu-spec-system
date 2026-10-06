export interface CachedBankAccount {
  xero_account_id: string;
  name: string;
  bank_account_type: string | null;
  status: string | null;
  current_balance: number | string | null;
  balance_as_of: string | null;
  balance_source: string | null;
  balance_synced_at: string | null;
  synced_at: string | null;
  account_currency_code?: string | null;
}

export interface CachedPaymentObservation {
  account_id: string | null;
  payment_date: string | null;
  is_reconciled: boolean | null;
  status: string | null;
  synced_at: string | null;
}

function latest(values: Array<string | null>): string | null {
  return values.filter((v): v is string => Boolean(v)).sort().at(-1) ?? null;
}

function decimal(value: number | string | null): string | null {
  if (value === null || value === "" || (typeof value === "string" && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : null;
}

/** A projection of cached ledger evidence, never a bank-feed certification. */
export function buildBankingEvidence(input: {
  connection: { last_sync_completed_at: string | null; last_sync_error: string | null; scopes: string[] } | null;
  accounts: CachedBankAccount[];
  payments: CachedPaymentObservation[];
  accountTotal: number;
  paymentTotal: number;
  offset: number;
  limit: number;
}) {
  const payments = input.payments.filter((p) => p.status === "AUTHORISED");
  const observationsComplete = input.payments.length === input.paymentTotal;
  return {
    source: "spec_xero_cache",
    connected: input.connection !== null,
    cache_last_completed_at: input.connection?.last_sync_completed_at ?? null,
    cache_last_sync_error: input.connection?.last_sync_error ?? null,
    bank_transactions_imported: false,
    bank_transactions_read_scope_granted: Boolean(input.connection?.scopes.some((s) =>
      ["accounting.banktransactions.read", "accounting.banktransactions", "accounting.transactions.read", "accounting.transactions"].includes(s))),
    evidence_limits: "Ledger report balances and imported payment flags only. Cache timestamps and payment dates do not prove feed freshness, statement completeness or account reconciliation. Report currency must be verified separately from account currency.",
    account_count: input.accountTotal,
    offset: input.offset,
    limit: input.limit,
    has_more_accounts: input.offset + input.accounts.length < input.accountTotal,
    payment_population: {
      cached_rows_total: input.paymentTotal,
      rows_examined: input.payments.length,
      complete: observationsComplete,
      unassigned_authorised_rows: payments.filter((p) => !p.account_id).length,
    },
    accounts: input.accounts.map((account) => {
      const observed = payments.filter((p) => p.account_id === account.xero_account_id);
      const amount = decimal(account.current_balance);
      return {
        xero_account_id: account.xero_account_id,
        name: account.name,
        bank_account_type: account.bank_account_type,
        status: account.status,
        account_currency_code: account.account_currency_code ?? null,
        ledger_balance: {
          amount_decimal: amount,
          availability: amount === null ? "missing_from_cache" : "cached_report_balance",
          source: account.balance_source,
          as_of: account.balance_as_of,
          retrieved_at: account.balance_synced_at,
        },
        account_metadata_retrieved_at: account.synced_at,
        payment_observations: {
          coverage: observationsComplete ? "cached_authorised_payments_only" : "partial_cached_authorised_payments_only",
          observed_count: observed.length,
          reconciled_true_count: observed.filter((p) => p.is_reconciled === true).length,
          reconciled_false_count: observed.filter((p) => p.is_reconciled === false).length,
          reconciliation_unknown_count: observed.filter((p) => p.is_reconciled !== true && p.is_reconciled !== false).length,
          latest_payment_date: latest(observed.map((p) => p.payment_date)),
          retrieved_at: latest(observed.map((p) => p.synced_at)),
        },
        statement_balance: null,
        last_bank_feed_success_at: null,
        bank_feed_error: null,
        unreconciled_statement_line_count: null,
        last_account_reconciled_at: null,
        missing_evidence_reason: "Bank statements, feed health and account reconciliation evidence are not imported or available through this Accounting API integration.",
      };
    }),
  };
}
