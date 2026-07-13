# emails/ — lead flow templates

**Lead flow round (migration 048) UPDATE:** the two files this folder
shipped with (`visit-confirmation.html`, `visit-reminder.html`) are
**NO LONGER PLACEHOLDERS**. Per `docs/RESLU-lead-flow-brief.md`, the
designer's real, brand-approved "paper card" templates have been
staged directly into this repo (they arrived as part of this round's
own package, not copied from `reslu-site/` by hand) — no further
on-machine copy step is needed for these two files. `lib/visit-
emails.ts`'s `loadTemplate()` reads them by filename at send time
exactly as before; nothing about that mechanism changed.

A third template joined this folder in the same round:
`emails/brief/project-brief.html` — the interactive pre-visit
questionnaire, served (not merged — see below) at `GET
/brief/[token]` via `lib/brief-page.ts`.

## Why the earlier placeholders existed

The r15 "Site-visit lifecycle emails" round shipped this folder with
two minimal, valid, table-based HTML files that exercised every
placeholder `lib/visit-emails.ts`'s `merge()` replaces, so the send
pipeline (trigger -> guard -> window check -> Resend -> log) was fully
testable end to end before the real brand templates existed. That
round's own README explained the reasoning at length; kept here only
as historical context now that the real templates have landed.

## Placeholders merged (`visit-confirmation.html` / `visit-reminder.html`)

`{{first_name}}` `{{visit_date}}` (e.g. "Tuesday 15 July")
`{{visit_time}}` (e.g. "10:00am") `{{phillip_phone}}` (defaults to
`+61 439 870 594` if the caller doesn't override it) `{{calendar_link}}`
(the Google Calendar "render" URL — `lib/ics.ts`'s
`leadVisitGoogleCalendarUrl()`) — plus, `visit-reminder.html` only,
`{{brief_link}}` (the tokenised `/brief/[token]` URL, minted lazily —
see `lib/lead-brief.ts`'s `ensureBriefToken()`). `merge()` in
`lib/visit-emails.ts` also still supports `{{last_name}}`/`{{suburb}}`
for backward compatibility even though neither current template
references them — a future template can use either with no code
change.

Both templates carry an `invite.ics` Resend attachment alongside the
HTML (native Apple Mail/Outlook "add to calendar," distinct from the
in-body "ADD TO CALENDAR" link) — see `lib/ics.ts`'s
`generateVisitIcs()` and `lib/lead-brief.ts`'s
`buildLeadVisitCalendarAssets()`.

## `emails/brief/project-brief.html` — served, not merged

Unlike the two email templates, this page carries **no**
`{{placeholder}}` tokens at all — the designer's page fills itself in
client-side as the client types (first/last name, letterhead flip, pen
date stamp) rather than needing any lead data baked in server-side.
`GET /brief/[token]` (`app/brief/[token]/route.ts` +
`lib/brief-page.ts`) therefore serves this file **verbatim**, cached
after the first read, identical for every lead's token — the ONE edit
made to the shipped file itself was wiring its submit handler
(previously a commented-out `fetch` example) to
`POST /api/brief-submit/[token]`, reading the token from
`location.pathname` client-side. See that route's own doc comment, and
`docs/API.md`'s "Lead flow" section, for the full submit/storage story.

## `trade-booking-request.html` / `trade-booking-reply.html` — Grouped trade booking round (r20)

Two new, plain (not the designer's script-font "paper card" style —
these are business/trade-facing, not the lead's client journey)
templates for `docs/BUILD-SPEC.md`'s "Grouped trade booking (r20)":

- **`trade-booking-request.html`** — the ONE email a trade receives
  covering every task/date line proposed for them on a project
  (replacing what used to be one email per visit). Placeholders:
  `{{company}}` `{{project_name}}` `{{project_address}}`
  `{{task_rows}}` (pre-built HTML `<tr>` rows — see
  `lib/trade-booking.ts`'s `buildTaskRowsHtml()`, merged verbatim, not
  further escaped by `merge()`) `{{request_link}}`
  (`https://spec.reslu.com.au/trade-request/{token}`)
  `{{attachments_note}}` `{{phillip_phone}}`. Sent via
  `POST /api/projects/[id]/trade-requests`.
- **`trade-booking-reply.html`** — the admin's short "keep original +
  reply" note (BUILD-SPEC.md item 5) sent from a trade-booking-request
  line's "Keep original + reply" action. Placeholders: `{{company}}`
  `{{message}}` `{{request_link}}` `{{phillip_phone}}`. Sent via
  `POST /api/trade-requests/[id]/lines/[visitId]/resolve`.

Both go through the same `lib/visit-emails.ts` `sendOrQueue()` /
`email_sends` / 7am-7pm Adelaide window machinery as the two lead
templates above (`record_type = 'trade_booking_request'`, migration
049 widens `email_sends.record_type`'s CHECK to allow it) — additive
entries in `TEMPLATE_FILES`/`VisitEmailMergeData`/`merge()`'s values
map, nothing about the existing lead-flow templates/sender/window
changed. Same "missing/unreadable file logs a `'skipped'` row and
`reportError()`s rather than crashing the caller" contract as every
other template here.

## `proposal-sent.html` — Fee proposal phase round (r23), reworked r25

Originally a plain "your fee proposal is ready" button-link email
(business style, not the designer's paper-card language). **Reworked in
the "Proposal delivery skin (r25)" round** to adopt the website's
card/packet language per `docs/RESLU-Card-Design-Spec.md` — the email
now IS the closed packet: bone `#EDE8DE` background, centred cardstock
card (`#faf6ec` / `1px solid #e6dfcf` / radius 1px, card shadow
deliberately omitted — card spec section 7: "shadows unreliable, fine to
skip" in email), a small typeset "debossed" RESLU mark (`#e2dac5` block,
letterspaced, two-tone border standing in for a bevel — NOT the
hotlinked `email-packet.jpg` photo `visit-confirmation.html`/
`visit-reminder.html` use below an open letter, since this card doesn't
have an "open letter" state to photograph past — it only ever shows the
closed packet), the `DESIGN PROPOSAL` taupe letterspaced label, the
client's first name(s) handwritten in pen (Caveat, `#274690`), the send
date **as plain text** (small letterspaced `#313131` — Phillip's
explicit correction: unlike a visit date, this is never handwritten),
the residence line, and a charcoal `OPEN YOUR PROPOSAL` button.

- **`proposal-sent.html`** — placeholders (all still merged by
  `lib/visit-emails.ts`'s `merge()`, reused unmodified — see
  `lib/proposal-emails.ts`'s own header comment for why that file itself
  stays untouched):
  - `{{company}}` — now the pen-written first name(s) on the packet
    (same greeting-name value the send/resend routes always computed —
    only where/how it's rendered changed, not the merge key or the
    route logic that fills it)
  - `{{project_name}}` — residence label (`lib/proposals.ts`'s
    `residenceLabel()`) — the plain "residence line" under the date
  - `{{visit_date}}` — **repurposed** by this template for the
    proposal's own plain-text send date (`"11 July 2026"`, Adelaide
    timezone) rather than a visit date — see
    `app/api/proposals/[id]/{send,resend}/route.ts`'s own
    `formatSentDateAdelaide()` comment for why this reuses the existing
    generic slot instead of adding a new key to `lib/visit-emails.ts`'s
    own `merge()` values map (kept untouched, same r23 file-boundary).
    A resend prints the ORIGINAL `sent_at` date, not the resend time.
  - `{{request_link}}` (`https://spec.reslu.com.au/proposal/{token}`) —
    the `OPEN YOUR PROPOSAL` button target
  - `{{project_address}}` / `{{attachments_note}}` / `{{phillip_phone}}`
    — still passed by both routes (harmless, land in `email_sends.detail`
    for audit) but **not referenced** by the r25 card markup —
    `{{project_address}}` in particular is deliberately dropped from the
    visible card per the card design spec's own voice rule: "Suburb
    only — never a client street address in anything sent or shown."

  Sent via `POST /api/proposals/[id]/send` and `.../resend`, through
  `lib/proposal-emails.ts`'s own thin `sendProposalEmail()` — that
  module deliberately does NOT add `'proposal'`/`'proposal-sent'` into
  `lib/visit-emails.ts`'s own private `VisitEmailRecordType`/
  `TEMPLATE_FILES` maps (this round's own file-boundary note keeps that
  file untouched); instead it reuses `merge()`/`sendViaResend()`/the
  7am-7pm Adelaide window gate unmodified and re-implements its own
  small `email_sends` log + template-file cache locally. See
  `lib/proposal-emails.ts`'s own header comment for the full reasoning.

**No `proposal-accepted.html` template file exists** — the signed-copy
confirmation email (sent to the client + `phillip@reslu.com.au` by
`POST /api/proposal/[token]/accept` once the client signs) is a short,
plain, INLINE HTML string built by that route itself (no template
file), the exact same "attach the PDF directly, simple branded HTML
body inline" shape `POST /api/client-invoices/[id]/send`'s own
`buildInvoiceEmailHtml()` already established for the client-invoicing
round — a transactional confirmation with a PDF attachment doesn't need
a hand-edited template file the way a marketing-adjacent lifecycle email
does.

## What happens if a file is missing or fails to load

Unchanged from the r15 behaviour: `lib/visit-emails.ts`'s
`sendOrQueue()` never crashes the caller's primary action (saving a
lead's site visit date) on a template read failure — it logs a
`'skipped'` `email_sends` row with a reason and calls
`reportError('visit-emails', ...)` (surfaced in admin Settings ->
System health), then returns cleanly. `GET /brief/[token]` mirrors this
for the brief page itself — a missing/unreadable `project-brief.html`
returns a plain 500 rather than crashing the request.
