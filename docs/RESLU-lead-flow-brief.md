# RESLU Lead Flow — build instructions (Claude Code, Spec repo)

You are wiring the RESLU "paper card" lead flow into the Spec CRM
(spec.reslu.com.au). Everything visual is already designed and built — do not
restyle anything. Your job is plumbing.

## What's in this package
- `cards/visit-confirmation.html` — email, sent when the Studio Visit is booked
- `cards/visit-reminder.html` — email, sent 48 hours before the visit;
  carries `{{brief_link}}`
- `cards/project-brief.html` — interactive pre-visit questionnaire (client
  answers in blue pen; paper folds on submit). Self-contained page.
- `cards/DESIGNER-NOTES.md` — the designer's own notes (see CORRECTIONS below)
- `reference/` — the design spec, animation brief, and original trigger brief

## Build tasks
1. **Host the project brief per lead.** Serve `project-brief.html` from Spec at
   a tokenised URL (e.g. `/brief/<token>`), one token per lead, so submissions
   attach to the right lead. That URL is what `{{brief_link}}` merges to.
2. **Wire the submit endpoint.** The marked block in project-brief.html
   (~line 440, commented `fetch` example) posts FormData. Fields:
   `first_name, last_name, hoping, favourite_spaces, materials, feel,
   must_1, must_2, must_3, bringing`. Store all answers on the lead record.
3. **Confirmation email** — send `visit-confirmation.html` when a visit is
   created/confirmed on a lead. Send once; re-send only if date/time changes.
4. **Reminder email** — daily cron (~7:00am Australia/Adelaide): visits ~48
   hours out that haven't had a reminder → send `visit-reminder.html` with the
   lead's `{{brief_link}}`; mark reminder_sent.
5. **Add to calendar.** Both emails carry an ADD TO CALENDAR link merging
   `{{calendar_link}}`. Generate a Google Calendar template URL per visit:
   `https://calendar.google.com/calendar/render?action=TEMPLATE&text=Site+Visit+%C2%B7+RESLU&dates=<start>/<end>&ctz=Australia/Adelaide&location=219+Sturt+Street,+Adelaide+SA+5000&details=With+Phillip.+Need+to+move+it%3F+Call+%2B61+439+870+594.`
   (default duration 1 hour, times in UTC per the GCal dates format).
   ALSO attach an `invite.ics` to both emails via Resend — that gives Apple
   Mail and Outlook their native add-to-calendar. ICS: METHOD:PUBLISH,
   TZID Australia/Adelaide, SUMMARY "Site Visit · RESLU", LOCATION
   "219 Sturt Street, Adelaide SA 5000", ORGANIZER aria@reslu.com.au.
   Keep the UID stable per visit; if date/time changes, re-send with the
   same UID and SEQUENCE+1 so calendars update in place.
6. **Merge placeholders:** `{{first_name}} {{last_name}} {{visit_date}}
   {{visit_time}} {{phillip_phone}} {{brief_link}} {{calendar_link}}`.
   Dates written out in body copy ("Tuesday 15 July"); times "10:00am";
   phone "+61 439 870 594".

## Sending
- Resend. Create a NEW API key for Spec (domain reslu.com.au is already
  verified) — do not reuse the website's key. Env var, never hardcoded.
- From: `Aria — RESLU <aria@reslu.com.au>` per the designer's journey guide;
  Reply-To: phillip@reslu.com.au.
- Log every send on the lead (timestamp + template). Send window 7am–7pm
  Adelaide only. Skip reminders for cancelled visits.

## CORRECTIONS to the designer's notes
- Where DESIGNER-NOTES.md says "log to the Monday.com lead card": WRONG —
  Monday is retired. All logging goes to the Spec lead record.
- Printing the completed brief is manual (Phillip presses print); do not
  build print automation.

## Rules
- Assets hotlink from reslu.com.au (logo, email-packet.jpg, begin-fold.mp4) —
  upload nothing, copy nothing.
- Do not modify the card HTML beyond inserting the endpoint URL and merge
  values. The visual system is locked by reference/RESLU-Card-Design-Spec.md.
- When a lead is set to Lost: clear its follow-up date, and cancel any
  pending reminder for it.
