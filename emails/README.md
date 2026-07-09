# emails/ — site-visit lifecycle templates

**INSTALL STEP (on-machine, not done by this round):** the two files in
this folder are **PLACEHOLDERS**. The real, brand-approved templates
live in the website repo at `reslu-site/emails/` (per
`docs/RESLU-Spec-Visit-Emails-Brief.md`) and are already DONE there —
this round's job was triggers/merge/sending, not template design.

**CC: copy these two files from the website repo into this folder,
overwriting the placeholders, before the first real send:**

```
reslu-site/emails/visit-confirmation.html  ->  emails/visit-confirmation.html
reslu-site/emails/visit-reminder.html      ->  emails/visit-reminder.html
```

Nothing else needs to change when you do this — `lib/visit-emails.ts`'s
`loadTemplate()` reads these two files by name at send time (cached
per warm serverless instance), so a straight file overwrite is picked
up on the next cold start / redeploy with no code change.

## Why placeholders, not a copy already

This working copy has no access to the website repo (`reslu-site/`) —
only the brief's description of what the templates contain (email-safe
HTML, tables + inline styles, no external CSS, hotlinking
`https://www.reslu.com.au/email-packet.jpg` for the hero image rather
than a local copy — "it stays in step with the site"). The two files
below are minimal, valid, table-based HTML that exercise every
placeholder `lib/visit-emails.ts`'s `merge()` replaces, so the send
pipeline (trigger -> guard -> window check -> Resend -> log) is fully
testable end to end before the real brand templates land. They are
NOT meant to ever reach a real client's inbox looking like this — each
file is clearly marked `PLACEHOLDER` in a visible HTML comment and in
a small on-page note.

## Placeholders merged (both templates)

`{{first_name}}` `{{last_name}}` `{{visit_date}}` (e.g. "Tuesday 15
July") `{{visit_time}}` (e.g. "10:00am") `{{suburb}}`
`{{phillip_phone}}` (defaults to `+61 439 870 594` if the caller
doesn't override it).

## What happens if a file is missing or fails to load

`lib/visit-emails.ts`'s `sendOrQueue()` never crashes the caller's
primary action (saving a lead's site visit date, creating a client
event) on a template read failure — it logs a `'skipped'`
`email_sends` row with a reason and calls `reportError('visit-emails',
...)` (surfaced in admin Settings -> System health), then returns
cleanly. Once the real files are copied in, the very next trigger for
that record sends normally (nothing needs replaying by hand — the
lead/event's next PATCH/edit, or the next day's reminder sweep for an
existing upcoming visit, picks it back up; see the guard's "re-send
only if date/time changed" semantics in `lib/visit-emails.ts`'s
`sendOrQueue` doc comment for what does and doesn't count as a fresh
trigger).
