# Stuart customer invoices — September 2026

## Verified issue

Stuart's controlled tool list contained only supplier-bill creation (`ACCPAY`). Invoice 00001252 is described in the live conversation as a RESLU Developments customer invoice to F&E Rocca for Radio Athens. The original PDF is a ready attachment in that conversation; no matching Spec customer invoice was found. The earlier review reported a printed line of $32,642.00 versus a header total of $32,642.01, with $2,967.46 GST. This work has not independently re-extracted the PDF, altered it, or created any Xero invoice.

## Narrow new capability

- Read source identity, its SHA-256, connected issuer and bounded revenue/tax-code choices. Source metadata is explicitly not content verification.
- Create only an AUD `DRAFT` `ACCREC`, with exact-owner approval bound to the complete payload and PDF fingerprint. The server independently checks the approval receipt, active Stuart actor, hash, expiry/revocation, expected absence and invoice-scoped idempotency key; a caller cannot bypass approval by directly invoking the endpoint. Stuart has a dedicated, single-capability receipt check and ledger claim: Aria's identity-gated approval RPCs remain unchanged.
- Require a ready original PDF in a conversation containing Stuart, one active existing customer contact, the connected legal issuer and approved revenue/sales-tax codes. See the owner-confirmed issued-invoice rule below for the sole one-cent net reconciliation exception.
- Reserve the existing action ledger atomically before the provider write. Concurrent attempts or uncertain outcomes cannot blindly repeat creation. Send a stable Xero idempotency key and check invoice-number duplicates, including deleted/voided history.
- Attach the original, read the invoice and attachments back from Xero, and verify dates, customer, amounts, tax codes, account codes, reference and DRAFT status before reporting success.
- No invoice authorisation, sending, payment, contact mutation, supplier-to-customer coercion, alteration of issued evidence or broader automatic discrepancy corrections.

## Owner-confirmed issued-invoice rule

Phillip clarified: “the invoice thats been sent to the client is gosple”. The issued document is authoritative, not a new amount reconstructed from its lines. This supersedes the original rule that escalated every one-cent difference.

- The exact approved source payload includes `issued_to_client: true` only after human confirmation or traceable evidence that this source was sent. Supply its original figures, not manually pre-adjusted lines.
- Preserve its total and GST. With exact agreement between line GST and header GST, allow at most one cent of net-line/subtotal disagreement. Set the Xero draft subtotal to issued total minus issued GST; adjust only the largest positive existing net line, using the first on a tie. No invented balancing charge, tax change, new invoice or replacement PDF.
- Record the rule version, original subtotal, original and resulting selected line amount, cent delta, issued total/GST and resulting payload hash in the existing action ledger before any Xero write. Preserve that reconciliation in success/partial receipts. Source approval still hashes the untouched original arguments, including the issued confirmation; it cannot be reused for changed inputs.
- The Workroom boundary discloses the rule. Larger differences, tax conflicts, unconfirmed issuance, invalid source identity and duplicate or uncertain writes still fail closed. Draft creation approval remains in place; no separate decision on which invoice to alter is needed for this one-cent case.
- The reported figures for 00001252 give an authoritative net amount of $29,674.55 ($32,642.01 less $2,967.46). A source net line of $29,674.54 receives a $0.01 net reconciliation in the draft only. These are tests based on the prior reported extraction, not a new independent PDF verification or evidence that a Xero draft was created.
- Fifteen focused contract/boundary tests cover the rule, increases/decreases, stable line selection, immutable source and tax, rejection cases and exact source-bound approval. Supabase guidance kept the audit in existing controlled tables; there are no schema, grant, RLS or approval-policy changes.

The Supabase skill informed reuse of the existing approval ledger without broader grants, new exposed tables or new privileged functions. The registry migration was applied and read back in production as `20260908082157`: the write is R2/exact-owner, Stuart-only; source lookup is R0/Stuart-only. The existing security advisor reports pre-existing warnings, so this is not a claim that the whole database has no security findings.

Sources: [Xero's official accounting schema](https://github.com/XeroAPI/Xero-OpenAPI/blob/master/xero_accounting.yaml) defines ACCREC, DRAFT, explicit line TaxAmount and idempotency headers; [Supabase API security](https://supabase.com/docs/guides/api/securing-your-api) distinguishes grants, RLS and additional request-level authorisation.

## Verification / remaining gate

- Nine focused tests passed, covering exact financial arithmetic (including the reported one-cent discrepancy), immutable DRAFT direction, source requirements, authority/replay rejection, readback and API boundaries. Eleven conversation-guard tests and five connector authority tests passed, retaining blocked attachment/forwarded writes, authorisation and sending. TypeScript, targeted ESLint and MCP syntax checks passed. Boundary tests inspect wiring; a real approved end-to-end write has not been exercised.
- The Mac mini address `arias-mac-mini.local` did not resolve using the existing trusted SSH configuration. Website release does not update its MCP process, guard plugin or injected Stuart instructions. Update that checkout and restart only the relevant services after checking active work; then confirm the new tool is listed.
- The issued-invoice authority decision is now confirmed. Invoice 00001252 still requires the existing exact draft approval and customer/contact/revenue/tax mapping, plus a reachable updated Stuart runtime. Do not treat this software change as proof of a Xero entry.
- No real financial write was used as a test. An approved end-to-end Xero draft/readback remains unverified until the above gate is met.

## Chat release completed separately

Chat rebuild PR #225 merged as `206475c86887c36899ceacc1b25cc913a0970f00`; Vercel production reported success. The live login returned HTTP 200 and its CSS contained the new chat workspace/reader rules. Unauthenticated Messages redirected to login. Final local type/lint and 84 bridge tests passed. Browser-control and physical-iPhone visual verification remain unavailable; this is deployment evidence, not device acceptance.
