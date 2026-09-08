# Stuart customer invoices — September 2026

## Verified issue

Stuart's controlled tool list contained only supplier-bill creation (`ACCPAY`). Invoice 00001252 is described in the live conversation as a RESLU Developments customer invoice to F&E Rocca for Radio Athens. The original PDF is a ready attachment in that conversation; no matching Spec customer invoice was found. The earlier review reported a printed line of $32,642.00 versus a header total of $32,642.01, with $2,967.46 GST. This work has not independently re-extracted the PDF, altered it, or created any Xero invoice.

## Narrow new capability

- Read source identity, its SHA-256, connected issuer and bounded revenue/tax-code choices. Source metadata is explicitly not content verification.
- Create only an AUD `DRAFT` `ACCREC`, with exact-owner approval bound to the complete payload and PDF fingerprint. The server independently checks the approved action, actor, hash, expiry/revocation and invoice-scoped idempotency key; a caller cannot bypass approval by directly invoking the endpoint.
- Require a ready original PDF in a conversation containing Stuart, one active existing customer contact, the connected legal issuer, approved revenue/sales-tax codes and exact agreement between source-line, GST and header amounts.
- Reserve the existing action ledger atomically before the provider write. Concurrent attempts or uncertain outcomes cannot blindly repeat creation. Send a stable Xero idempotency key and check invoice-number duplicates, including deleted/voided history.
- Attach the original, read the invoice and attachments back from Xero, and verify dates, customer, amounts, tax codes, account codes, reference and DRAFT status before reporting success.
- No invoice authorisation, sending, payment, contact mutation, supplier-to-customer coercion or automatic rounding adjustment.

The Supabase skill informed reuse of the existing approval ledger without broader grants, new exposed tables or new privileged functions. The registry migration was applied and read back in production as `20260908082157`: the write is R2/exact-owner, Stuart-only; source lookup is R0/Stuart-only. The existing security advisor reports pre-existing warnings, so this is not a claim that the whole database has no security findings.

Sources: [Xero's official accounting schema](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml) defines ACCREC, DRAFT, explicit line TaxAmount and idempotency headers; [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) distinguishes grants, RLS and additional request-level authorisation.

## Verification / remaining gate

- Eight focused tests cover exact financial arithmetic (including the reported one-cent discrepancy), immutable DRAFT direction, source requirements, authority/replay rejection, readback and API boundaries. Eleven conversation-guard tests retain blocked attachment/forwarded writes, authorisation and sending. TypeScript, targeted ESLint and MCP syntax checks pass.
- The Mac mini address `arias-mac-mini.local` did not resolve using the existing trusted SSH configuration. Website release does not update its MCP process, guard plugin or injected Stuart instructions. Update that checkout and restart only the relevant services after checking active work; then confirm the new tool is listed.
- The user has not yet answered whether to create a draft or only repair the capability. Even with draft approval, resolve the one-cent source discrepancy and approve the exact customer/contact/revenue/tax mapping before creating invoice 00001252. Do not silently insert a balancing line.
- No real financial write was used as a test. An approved end-to-end Xero draft/readback remains unverified until the above gate is met.

## Chat release completed separately

Chat rebuild PR #225 merged as `206475c86887c36899ceacc1b25cc913a0970f00`; Vercel production reported success. The live login returned HTTP 200 and its CSS contained the new chat workspace/reader rules. Unauthenticated Messages redirected to login. Final local type/lint and 84 bridge tests passed. Browser-control and physical-iPhone visual verification remain unavailable; this is deployment evidence, not device acceptance.
