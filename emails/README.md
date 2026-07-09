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

## What happens if a file is missing or fails to load

Unchanged from the r15 behaviour: `lib/visit-emails.ts`'s
`sendOrQueue()` never crashes the caller's primary action (saving a
lead's site visit date) on a template read failure — it logs a
`'skipped'` `email_sends` row with a reason and calls
`reportError('visit-emails', ...)` (surfaced in admin Settings ->
System health), then returns cleanly. `GET /brief/[token]` mirrors this
for the brief page itself — a missing/unreadable `project-brief.html`
returns a plain 500 rather than crashing the request.
