# Customer receipt integration and activation

This is a disabled development candidate. It has not been deployed, granted additional Xero consent, or used to record a real payment.

## Conversation and MCP boundary

Read-only preparation can be released independently: set `STUART_XERO_CUSTOMER_RECEIPT_PREPARATION_ENABLED=true` in the server and Stuart MCP environment, activate only its R0 registry row, and set trusted guard config `enableStuartCustomerReceiptPreparation: true`. The recording flag, record policy and payment-write consent remain closed. This setting cannot expose or invoke the recording tool. Both preparation confirmations stay false and no authority receipt or action claim is created.

The connector exposes `prepare_stuart_xero_customer_receipts` and `record_stuart_xero_customer_receipts` only when `RESLU_AGENT_ROLE=stuart` and `STUART_XERO_CUSTOMER_RECEIPTS_ENABLED=true` in that MCP process. Hidden tools also reject direct invocation before authentication or any API call. Other agents cannot obtain the tools through the general Aria registry.

The Mac guard separately requires the trusted plugin setting `enableStuartCustomerReceipts: true`. It recognises only the `reslu-stuart__...` and `mcp__reslu_stuart__...` names for these two tools. Forwarded messages, attachment-review turns, specialist consultations and missing bridge envelopes remain blocked. Setting a similarly named field in tool arguments or run state cannot activate it. Other Stuart payments, approvals and host tools retain their restrictions.

The web routes have their own activation, actor and authority checks. A permitted conversation tool call is not an accounting approval. Preparation returns a proposal with both confirmation flags false. The owner's exact final approval must bind the received-funds/source confirmations and every other field of the executable plan. `deriveActionTarget` uses the same tenant/customer/remittance identity as the executor, including uppercasing the reference. The executor requires the original source hash as `expected_version` and rejects `expected_absent=true`.

## Review before production activation

1. Merge this scoped candidate with the actual deployment source. Its starting revision is `0ebd7aa02489e0511f4af8fae4918d38122c2d45`; the production Mac has substantial additional local work. In particular, preserve the already installed PR #234 finance-review aliases, newer customer-invoice support, Gmail changes and all unrelated edits. Never replace whole production files from this older checkout or reset it.
2. Validate the registry migration in a disposable database before applying it. It inserts the two policies as **inactive** and changes no grants. Reuse the existing immutable authority/action ledger. Confirm the configured owner is the intended active human administrator, not any agent/service identity.
3. Review website deployment, MCP environment and Mac plugin changes separately. A website deployment does not reload the Mac plugin. Keep the record policy inactive while verifying the read-only preparation flow and exact remittance proposal. Re-run guard tests and collect fresh runtime/worker evidence after any later Mac service reload.
4. Xero payment-writing consent is a separate activation requirement. Existing granted scopes have not changed. Follow the release notes for the exact supported scope and required owner consent; do not silently expand access or infer that existing payment-read access permits recording receipts.
5. Only after a concrete exact allocation is reviewed may its final approval be issued by the configured human owner. This development task does not submit that approval or the financial action. The earlier automatic approval rejection still requires user handoff for the final consequential financial action; do not route around it via a new API or agent.
6. Verify each actual provider payment identifier, amount, date, invoice, account and resulting balance after an approved live operation. Do not mark access operational or invoices paid based on code/tests alone. A partial result is delivered intact through MCP and requires read-only recovery; never resend it merely because a response was interrupted.

## Stop and rollback

Disable the record registry policy and `STUART_XERO_CUSTOMER_RECEIPTS_ENABLED`, remove/disable the optional guard setting, and reload only the affected existing services using their documented procedures. Preserve all action claims and outcome receipts; deleting those would remove duplicate protection. Disabling code never reverses an accounting entry. Any actual payment correction requires separate human review in Xero.

The preparation and execution modules use mocked provider ports for tests. Real MCP transport tests use fake credentials and unreachable loopback URLs; they list tools and reject hidden calls without authenticating. No financial write is a connectivity test.

The existing database security boundary was reviewed against [Supabase's API security guidance](https://supabase.com/docs/guides/api/securing-your-api). This candidate does not add public grants, service-role credentials to clients, or new privileged database functions.
