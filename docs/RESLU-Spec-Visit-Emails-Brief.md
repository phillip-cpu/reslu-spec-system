# Spec — Site-visit lifecycle emails (brief)

Client-facing emails for site-visit milestones, in the website's "folded brief"
brand language. The templates and imagery are DONE and live in the website repo
— Spec's job is triggers, merge, and sending.

## Templates (copy them into Spec's codebase)
In the website repo: `reslu-site/emails/`
- `visit-confirmation.html` — send when a site visit is booked/confirmed
- `visit-reminder.html` — send the day before the visit

Both are email-safe HTML (tables, inline styles, no external CSS). The packet
hero image is hosted at `https://www.reslu.com.au/email-packet.jpg` — hotlink
it, don't copy it (it stays in step with the site).

## Placeholders to merge
`{{first_name}}` `{{last_name}}` `{{visit_date}}` (e.g. "Tuesday 15 July")
`{{visit_time}}` (e.g. "10:00am") `{{suburb}}` `{{phillip_phone}}` (+61 439 870 594)

## Triggers
1. **Confirmation** — when a visit is created or its status becomes confirmed
   on a lead/job. Send once (guard against re-sends on edits; re-send only if
   date/time changed, with the same template).
2. **Reminder** — daily cron (Vercel cron is fine, ~7:00am Adelaide time):
   find visits scheduled for TOMORROW that haven't had a reminder sent, send
   `visit-reminder.html`, mark reminder_sent on the record.

## Sending
- Via Resend (Spec gets its own RESEND_API_KEY — do NOT reuse the website's;
  create a second key in the same Resend account, domain is already verified)
- From: `Phillip — RESLU <visits@reslu.com.au>` · Reply-To: phillip@reslu.com.au
- Log every send on the lead/job record (timestamp + template)

## Rules
- Client-facing copy: brand voice, no banned words, no em dashes
- Never send outside 7am–7pm Adelaide time
- If a visit is cancelled before the reminder fires, don't send it
- Timezone: Australia/Adelaide for all date maths

## Future milestones (same pattern, not in this build)
Brief accepted · design presented · construction start · handover. Each gets a
template in reslu-site/emails/ when its time comes — ask Fable.
