# Stuart customer receipts — disabled development candidate

Prepared 28 September 2026. This candidate adds the missing ability to prepare and record **already received AUD customer receipts against existing approved ACCREC invoices**. It does not transfer money, create or approve invoices, pay suppliers, issue refunds, change bank details, reconcile bank feeds or execute instructions from email content.

**Nothing in this candidate was deployed, enabled, consented to or run against live financial records. No Fairmont invoice has been marked paid by this development work.** The prior automatic approval rejection remains binding; this capability must not be used as an indirect route around that rejection.

## What exists and why a new capability was needed

The inspected production checkout was `/Users/vale/reslu-spec-system`, HEAD `0ebd7aa02489e0511f4af8fae4918d38122c2d45`, with substantial unrelated local changes. It was left untouched. Development uses a separate clone, branch `codex/stuart-xero-customer-receipts`.

The production code supports finance reads, supplier contact creation and draft supplier bills, but requests `accounting.payments.read`. No receipt/remittance allocation writer was found in the inspected Stuart/Xero/MCP paths or the bounded local git-history review. A separate existing customer-invoice draft feature in local git was inspected as an authority/audit reference; it is not receipt allocation, and its unrelated changes were not pulled into this candidate.

## Candidate flow

1. `prepare_stuart_xero_customer_receipts` calls the read-only preparation route with an exact Accounts email/attachment, customer name, receiving-account suffix, remittance reference/date and invoice numbers/amounts. It resolves one active customer, one existing active AUD bank account, exact live invoice IDs and balances, and the original PDF fingerprint. Ambiguous matches stop. It checks existing payments.
2. Preparation returns a reviewable plan and stable authority target/key. Both `money_received_confirmed` and `source_reviewed_confirmed` are **false**. Preparation never creates approval, confirms a bank receipt or changes financial records. The source hash proves document identity; it does not prove the document's claims are true.
3. The configured human owner/admin reviews the PDF, actual receipt date, account, currency, all allocations and balances, confirms that the money has arrived, and approves the exact final payload through existing Workroom/effect-preview authority. Confirmation flags must be true in that approved payload. A plain `human_confirmed` flag, email assertion, old approval, another administrator or agent identity is insufficient.
4. `record_stuart_xero_customer_receipts` calls the server route with that exact payload and `_authority`. The server rechecks active Stuart identity, the exact enabled policy, configured human approver, unexpired/unrevoked approval, source version, tenant, live account and all live invoices before claiming anything.
5. The server atomically claims the remittance and allocation keys in the existing action ledger. It writes one receipt per invoice using `PUT /Payments`, always `IsReconciled: false`, then GETs the payment and invoice. Only exact provider readback can mark an allocation verified. Partially paid invoices remain `AUTHORISED` with a remaining balance; the code never sets invoice status itself.
6. Each result contains action-run ID, known payment IDs, verified/uncertain/not-attempted allocation states and remaining amounts. A partial result is returned as successful JSON transport so the MCP client preserves recovery evidence; **HTTP 200 is not completion**. Callers must check `state === "verified"` and `audit_saved === true`.

No unattended email-to-payment execution is implemented. Autonomous remittance discovery/matching may prepare a proposal, but this candidate requires exact human approval before recording receipts.

## Duplicate and uncertainty handling

The remittance key includes Xero tenant, exact customer and case-normalised remittance reference. Allocation claims also bind tenant/source SHA/invoice and tenant/invoice/date/amount. One atomic insert acquires all keys under the existing ledger uniqueness constraint. Changing request IDs, attachment copies, references or PDF encoding cannot silently replay an identical allocation. The amount/date key intentionally blocks some potentially legitimate repeat receipts for manual review.

Before each individual write the code rechecks approval, connection, bank account, invoice balances and existing payments. A matching reference, or matching invoice/date/amount even under another reference/account, stops the operation. Unknown payment states or an incomplete bounded lookup stop it too.

The provider receives a stable `Idempotency-Key`. Xero retains idempotency responses for only six minutes, so it is an additional protection, **not** the durable replay guard. A previously claimed operation is never automatically reissued, including after a timeout, process crash, validation response, readback mismatch, revoked approval or audit failure.

Progress is saved before the provider call, then again when the provider identifier is known, then after readback. A failure stops the remaining allocations. Previously verified payments are retained and reported; there is no automatic reversal. If durable auditing fails, return data retains every known payment ID and reports the audit failure.

Recovery is deliberately manual and read-only first: inspect root action metadata and the linked allocation locks, GET every known payment and invoice, then inspect any uncertain invoice's complete payment history. Do not delete audit/lock rows, alter references or resubmit to bypass a claim. A separately reviewed recovery change is needed to release conclusively unattempted allocations or finish an uncertain journal after provider readback; this candidate has no automated recovery writer. This conservative limitation means a partial multi-invoice remittance cannot simply be retried.

## Scope and activation gates

The normal OAuth scope list is unchanged. A separate opt-in `XERO_CUSTOMER_RECEIPTS_WRITE_CONSENT_ENABLED=true` makes the **next human OAuth consent request** substitute granular `accounting.payments` for `accounting.payments.read`. It does not change an existing token or start a consent flow. No broader transactions, bank-transaction, journal or payroll scope is added.

`accounting.payments` is the minimum current Xero API scope for payment writes; it also permits operations beyond incoming receipts at the provider level. The narrow application contract, exact approval and guard therefore remain essential. Existing invoice/settings read access remains required; preparation additionally needs existing contact-read access. Refreshing a read-only token will not grant the new permission: an authorised human must reconnect and consent after the activation is reviewed. Xero user roles may independently limit calls.

All gates default closed:

- Server and Stuart MCP process: `STUART_XERO_CUSTOMER_RECEIPTS_ENABLED` must explicitly equal `true`.
- Server: `STUART_XERO_RECEIPTS_OWNER_PROFILE_ID` must identify the intended confirmed, unbanned human administrator, with no conversation-agent identity.
- Database: the new prepare/record registry rows are installed inactive. They must be separately reviewed and activated with their exact R0-read/R2-commit policies and only Stuart allowed.
- OpenClaw: trusted plugin config `enableStuartCustomerReceipts` must explicitly be true. Forwarded content, attachment-review turns, specialist consultations and invalid envelopes remain denied, including exact Codex aliases.
- OAuth: payment-write scope must be granted through a separately reviewed human consent flow; the code verifies the stored granted scopes and exact connected tenant.

See [integration and deployment notes](STUART-CUSTOMER-RECEIPTS-INTEGRATION.md) for the MCP/guard configuration, inactive migration, approval-target wiring and staged activation/rollback. The exact changes must be reconciled with the production checkout's dirty state; never deploy this older-base clone wholesale or discard local work. Website deployment alone does not reload the Mac plugin/MCP processes.

## Verification and limits

Synthetic tests cover exact approval identity/version/expiry, AUD and ACCREC restrictions, wrong/ambiguous account/customer matches, integer-cent totals, source-byte fingerprints, duplicate/concurrent claims, timeout/lost responses, readback mismatch, pre/post-provider audit failures, partial balances and false preparation confirmations. MCP and guard tests cover default-off discovery, direct hidden-tool denial, trusted configuration and context restrictions. TypeScript and focused lint checks run locally.

No live Xero payment, bank reconciliation, database migration or consent was exercised. The real Supabase atomic bulk-insert claim and real Xero response shapes must be verified in an authorised test organisation/staging deployment before production activation. Server-unit tests use injected fake ports; they do not certify a live payment operation.

The preparation flow supports stored PDF remittances from Accounts only, one remittance with at most 20 invoice allocations, AUD base/account/invoice currency and one unambiguous existing bank account. No mixed currency, credit notes, overpayments, new invoices/accounts, split-account receipts or source-body-only remittances. Live rate limits can stop a larger remittance part-way; partial progress must be handled through the documented review path, never blind retry. Scheduling/backoff and automated safe continuation are not part of this candidate.

## Primary Xero references checked

- [Payments API](https://developer.xero.com/documentation/api/accounting/payments): create invoice payments with PUT; the account must support payments, the amount cannot exceed the invoice amount due, and reconciliation is a separate property.
- [Idempotent requests](https://developer.xero.com/documentation/guides/idempotent-requests/idempotency/): use `Idempotency-Key`; cached responses expire after six minutes.
- [Xero changelog](https://developer.xero.com/changelog): granular Accounting scopes replace broad transaction scope, including `accounting.payments`; migration requires reconnecting with the required scopes.
- [OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes/): current scope reference for activation review.
