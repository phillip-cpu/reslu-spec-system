# RESLU ↔ Xero integration plan

## Outcome

Give RESLU a read-only accounting cross-check inside Spec before any
write-back is considered. The first release answers:

- Has this supplier bill reached Xero, and is it draft, authorised,
  paid, voided or credited?
- Has this RESLU client invoice reached Xero, and what is its current
  amount due and payment state?
- Do the supplier/client, invoice number, date, GST and total agree?
- Which records are exact matches, probable matches, unmatched or in
  conflict?
- What is billed, paid, owing and overdue by project?

This replaces no accounting system and has no dependency on Monday.
Xero remains the accounting source of truth; Spec remains the project,
scope and operational source of truth.

## Phase X1 — read-only reporting

1. Connect one RESLU Xero organisation through OAuth 2.0.
2. Request only the minimum read scopes needed: invoice, payment,
   contact and organisation/settings reads, plus `offline_access` for a
   durable connection. Xero assigned granular scopes to Web/PKCE apps
   from March 2026, so the implementation should use those rather than
   the older broad transaction scope.
3. Encrypt refresh tokens at rest and keep them server-side. Never put
   Xero credentials in browser code, Aria's workspace files or logs.
4. Import Xero sales invoices and purchase bills, their contact,
   balances and payments. Xero's Invoices endpoint covers both sales
   invoices and purchase bills; payment status is cross-checked from
   invoice balances and the Payments endpoint.
5. Store a read-only sync cache and immutable sync audit log. Use Xero
   invoice identifiers as the durable external key.
6. Match:
   - purchase bills (`ACCPAY`) to Spec `invoices` (supplier money out);
   - sales invoices (`ACCREC`) to Spec `client_invoices` (client money in).
7. Show four clear match states:
   - **Exact** — direction, invoice number, contact and totals agree;
   - **Probable** — strong total/date/contact match but one identifier
     is absent or formatted differently;
   - **Unmatched** — only one system has the record;
   - **Conflict** — the same invoice identity has different totals,
     GST, contact or direction.
8. Add a project Finance/Xero panel and a company-level exceptions
   report. No Xero data changes are possible in X1.

## Synchronisation

- Initial bounded backfill, then incremental sync by Xero update time.
- Invoice/contact webhooks wake a targeted refresh; a scheduled
  reconciliation remains the safety net because webhooks are event
  notifications, not the complete financial record.
- Verify the `x-xero-signature` HMAC before accepting a webhook and
  acknowledge valid webhook calls quickly before doing background work.
- Respect Xero response rate-limit headers, bounded concurrency and
  `Retry-After`; cache and batch rather than polling each invoice.
- Every sync records tenant, run time, records checked, matched,
  conflicted, failed and the last successful cursor.

## Matching rules

Normalisation may ignore harmless formatting differences such as
spaces, punctuation and leading zeros, but never silently changes money.
The confidence order is:

1. Xero ID already linked to a Spec record.
2. Direction + invoice number + normalised contact.
3. Direction + exact total + nearby invoice date + contact.
4. Project/job reference found in Xero reference or line description.

Only rule 1 or a high-confidence rule 2 can auto-link. Probable matches
remain suggestions for an admin to confirm. A conflict is never
auto-resolved.

## Phase X2 — optional controlled write-back

Only consider this after X1 has run safely and been reconciled. Possible
features are creating a draft Xero bill/invoice from an already-approved
Spec record, or writing the confirmed Xero ID back to Spec. Every write
requires an explicit admin approval, is idempotent, and keeps the source
document link. RESLU should not create payments, reconcile bank
transactions, void invoices or alter approved Xero records automatically.

## Resources Phillip will need to provide

- Access to the RESLU organisation in Xero with permission to authorise
  an app.
- A Xero developer app, its client ID and client secret.
- The production callback URL supplied by the Spec deployment.
- Confirmation of the Xero organisation/tenant to connect.
- Confirmation that supplier bills in Xero are consistently entered as
  purchase bills and RESLU client invoices as sales invoices.
- Two or three real examples for each direction, including a paid,
  unpaid and mismatched example where possible.
- The preferred reporting view: project only, company-wide, or both
  (recommended: both).

Do not paste the client secret into chat or commit it to GitHub. It will
be added directly to Vercel's encrypted Production/Preview environment
variables when X1 begins.

## Official references checked 15 July 2026

- [Xero Accounting API overview](https://developer.xero.com/documentation/api/accounting/overview)
- [Xero OAuth scopes](https://developer.xero.com/documentation/guides/oauth2/scopes)
- [Xero Invoices endpoint](https://developer.xero.com/documentation/api/accounting/invoices)
- [Xero Payments endpoint](https://developer.xero.com/documentation/api/accounting/payments)
- [Xero webhooks](https://developer.xero.com/documentation/guides/webhooks/overview/)
- [Xero rate limits](https://developer.xero.com/documentation/best-practices/api-call-efficiencies/rate-limits)

