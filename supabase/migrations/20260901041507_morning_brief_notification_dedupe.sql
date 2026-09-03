-- One private Morning Brief notification per recipient and Adelaide-local
-- date, even when two scheduler invocations overlap between the application
-- dedupe read and insert. Other notification kinds keep their existing
-- multiplicity semantics (messages/events can legitimately repeat).
create unique index if not exists notifications_morning_brief_recipient_unique
  on public.notifications (user_id, kind)
  where user_id is not null and kind like 'morning_brief:%';

comment on index public.notifications_morning_brief_recipient_unique is
  'Race-safe per-admin/per-day dedupe for the 7am Morning Brief. The date is encoded in kind as morning_brief:YYYY-MM-DD.';
