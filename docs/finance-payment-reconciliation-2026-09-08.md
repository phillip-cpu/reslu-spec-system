# Finance payment reconciliation — 8 September 2026

Implementation branch: `codex/finance-payment-reconciliation`, based on `3603b814`.

## What changes

- The Xero closing cash date is an explicit cutoff. Payments already represented by that balance are not deducted again. A manual opening balance is start-of-day on the selected date.
- Supplier payments retain dated instalments. Increasing total paid records only the increment on the new date, rather than moving all earlier payments. Existing aggregate payments keep their known date; older instalment dates are not invented.
- A lower cached Xero paid total cannot reopen a locally paid bill. Conflicts remain visible. Missing Xero payment dates stay unknown; invoice dates are not treated as payment dates.
- Approved AUD company bills enter the same supplier reconciliation as project bills. Unknown/foreign-currency company bills stay outside AUD totals with an explicit warning.
- An explicitly linked AUD company bill replaces one recurring occurrence, not the series. Manual and invoice evidence for that occurrence are not added as two payments.
- Recurring payments can be recorded, part-paid and corrected in the existing Planned outgoings view. Corrections retain an audit record and do not imply a cash refund.
- Active unpaid recurring occurrences persist from the migration's tracking start date. Pre-migration anchor dates are not used to fabricate a backlog or mark historical expenses paid. Newly entered overdue one-time outgoings remain visible.
- Weekly outflows focus the relevant company bill or recurring occurrence. Project bills still open the existing project invoice. Old overdue amounts are labelled as awaiting payment confirmation.
- Committed cash and the planning view including project estimates are available on the same chart. Bank-sync status is separate from payment coverage.

## Verification

- 129 finance unit/regression tests pass (`node --test lib/finance/*.test.ts`).
- 21 isolated Postgres-compatible migration/RLS/RPC smoke checks pass, including payment increments, correction history, permission denial, optimistic locking, link uniqueness and AUD-only links.
- Eight interaction checks use the actual Finance React components with synthetic API fixtures: view switching, payment warnings, source navigation/focus, saving payments, refresh, undo and permission gating. No production API requests are made by this harness.
- TypeScript, changed-file ESLint and production webpack build checked.
- Live schema constraints, existing invoice triggers and finance capability function signature inspected read-only for compatibility.
- SQL smoke harness uses a minimal schema and stub capability functions; it is not a full production database clone. No real payments or invoice classifications have been changed by these tests.

SQL smoke command (install PGlite 0.5.8 outside the repository):

```sh
PGLITE_MODULE_PATH=/absolute/node_modules/@electric-sql/pglite/dist/index.js node scripts/test-finance-payment-migrations.mjs
```

UI smoke command (install esbuild 0.25.10 and jsdom 26.1.0 in an isolated temporary directory):

```sh
FINANCE_UI_TEST_DEPS=/absolute/temp/directory node scripts/test-finance-payment-ui.mjs
```

## Rollout order

Apply these additive migrations before deploying code that reads their columns/table:

1. `supabase/migrations/20260908073428_recurring_occurrence_payments.sql`
2. `supabase/migrations/20260908073459_supplier_payment_history.sql`

Then deploy the reviewed branch and verify with an authorised account: open a weekly outgoing, record an evidence-backed payment, reload, and check that only the unpaid remainder stays in future cash. Do not create fictitious payments in production for testing.

Database deployment verified on 8 September 2026. Filenames match the versions recorded by Supabase. Existing invoice totals, payment statuses, paid amounts and dates were unchanged; no payment records were created. RLS and grants were verified live. Application deployment is tracked by the associated release PR. Unrelated local OpenClaw edits are not part of this patch.

The post-migration security advisor flags the authenticated payment RPCs as intentionally executable security-definer functions. Both enforce authenticated identity and the finance editing capability, deny anonymous access, and use an empty search path. See the [Supabase advisor explanation](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable).

## Data still needing evidence

A fresh bank balance alone cannot establish which local bills are paid. Payment coverage is reported separately. This patch does not add Xero BankTransactions import or fuzzy supplier-name matching.

Old approved invoices recorded as unpaid must be reconciled against actual receipts/payment records; moving their due date is not a solution. Suspected credit-note classification errors require source-document-backed corrections, not invented payments. Internal invoice identifiers and financial observations are not included in this public release report.

Client contract-credit/refund policy is unchanged. Existing payment records with only a single aggregate date cannot retrospectively recover unknown instalment dates. History beyond the API's safe loading limit fails visibly rather than silently returning partial totals.

Pausing/archiving stops the generated recurring schedule, including unpaid generated occurrences without saved payment history. Recorded payments and recorded outstanding obligations remain. It is not a payment or debt-settlement action.
