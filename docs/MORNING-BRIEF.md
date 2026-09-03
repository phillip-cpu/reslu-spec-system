# Morning Brief

The Morning Brief is a 7:00am Australia/Adelaide push plus today's agenda and
a ranked action list on My Work. It is designed as one useful interruption,
not a stream of reminders.

## Product decisions

- One notification per admin per local date. The notification kind is
  `morning_brief:YYYY-MM-DD`, and delivery is deduped before insertion.
- Private exact-id delivery. Each admin gets a separate `notifications` row;
  the push provider receives only its opaque UUID.
- Privacy-safe copy. The lock screen shows counts such as bookings and orders,
  never client, supplier or project names. Full detail stays behind the
  authenticated `/my-work#daily-brief` link.
- Three actions first. Booking and ordering blockers lead, explicit risk words
  such as expired/overdue raise an item, and carried-over work rises gradually.
  The remaining list stays visible under “Then.”
- Today's orientation sits in its own section and does not displace the top
  three actions: project client meetings, lead site visits, confirmed/tentative
  trade visits, and birthdays.
- Birthdays store `MM-DD` only. RESLU never collects a birth year or derives an
  age. Team dates are maintained in Settings; other people are maintained in
  Contacts.
- One action verb per row. The deep link says what it does: Book trade, Review
  order, Resolve, Follow up, Reply, or Review invoice.
- No empty push. A morning with no open actions records a successful no-op and
  sends nothing.
- Daylight-saving-safe delivery. Vercel invokes both possible UTC offsets; the
  route only runs when Adelaide local time is 7am.
- Observable execution. Every accepted cron run records success, degradation,
  or failure in `system_job_runs`, including zero-item mornings.

## Research basis

- [Apple notification guidance](https://developer.apple.com/design/human-interface-guidelines/notifications): notifications should be timely, high-value, concise, non-duplicative, and avoid sensitive lock-screen information.
- [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers): Home Screen web apps support standards-based Web Push, visible notifications, deep links, urgency, and provider coalescing.
- [Android notification guidance](https://developer.android.com/design/ui/mobile/guides/home-screen/notifications): lead with the most important information, preview the content, expose an obvious action, group duplicates, and open the directly related UI.
- [Firebase web notification guidance](https://firebase.google.com/docs/cloud-messaging/web/receive-messages): use precise titles, meaningful icons, relevant copy, and a link back to the specific app destination.

## Main implementation

- `lib/morning-brief.ts` — pure ranking, Adelaide time gate, safe copy.
- `lib/morning-brief-notify.ts` — per-admin persistence, dedupe, exact push.
- `app/api/brief/generate/route.ts` — generation, notification and job logging.
- `components/my-work/DailyBrief.tsx` — First up / Then action list.
- `public/sw.js` — visible notification and deep-link handling.

## Calendar boundary

The brief currently reads RESLU's authoritative scheduling tables. The
dedicated RESLU Google Calendar receives trade-visit writes through Aria, but
the app has no read connection for unrelated Google/Apple/Outlook events.
Those personal/external appointments require an explicit calendar connection
and consent before they can appear here; they are not silently inferred.
