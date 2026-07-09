-- ============================================================
-- RESLU Spec System — Site-visit lifecycle emails
-- BUILD-SPEC.md §"Site-visit lifecycle emails" / docs/RESLU-Spec-Visit-
-- Emails-Brief.md: client-facing "your site visit is booked" /
-- "your site visit is tomorrow" emails, covering BOTH lead site visits
-- (leads.site_visit_date) and project client_events (the client-events
-- feature, migration 020) — two different source tables, one shared
-- send log.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - text + CHECK instead of a Postgres enum (house style)
--   - idempotent throughout (create table if not exists / drop+recreate
--     policy) so a partial apply converges cleanly on re-run
--   - RLS: single permissive "team_all" policy (Phase 1 — "no
--     unenforced role theatre"; this table carries no financial data)
--
-- ============================================================
-- email_sends — doubles as BOTH the send-guard (never send the same
-- template twice for the same visit date/time) AND the 7am-7pm
-- Adelaide sending-window queue (a send attempted outside the window is
-- logged 'pending' with scheduled_for = next 7am Adelaide, then picked
-- up by GET/POST /api/visit-emails/run's flush pass).
--
-- record_type/record_id: polymorphic reference (no FK — 'lead' rows
-- point at leads.id, 'client_event' rows point at client_events.id;
-- two possible parent tables, so a real FK constraint isn't possible
-- without a check-constraint-enforced single-parent redesign of either
-- source table, which is well out of this migration's scope). Reads
-- that need the parent row do a second lookup keyed on record_id, same
-- polymorphic-reference pattern this codebase already uses for
-- board_tasks.visit_id (nullable, no dedicated FK per visit "kind").
--
-- detail jsonb: a snapshot of the merge data used for THIS send/queue
-- attempt, taken at write time — critically including the visit
-- datetime being confirmed/reminded (detail.visit_datetime). This is
-- what the re-send guard in lib/visit-emails.ts compares against: a
-- 'sent' row whose detail.visit_datetime matches the CURRENT visit
-- datetime blocks a duplicate send; a 'sent' row logged against a since-
-- changed (rescheduled) datetime does not, so editing a visit's date/
-- time correctly triggers exactly one fresh confirmation. detail also
-- carries the rendered subject line for pending rows, so the flush pass
-- can re-render + send without re-deriving anything from the parent
-- record (which may have changed again since the row was queued).
-- ============================================================
create table if not exists email_sends (
  id            uuid primary key default gen_random_uuid(),

  record_type   text not null check (record_type in ('lead', 'client_event')),
  record_id     uuid not null,

  -- Template file name (without extension) — 'visit-confirmation' or
  -- 'visit-reminder', matching the emails/*.html filenames 1:1 (see
  -- lib/visit-emails.ts's loadTemplate()). Free text, not a CHECK
  -- enum — new milestone templates (brief accepted, design presented,
  -- construction start, handover — see the brief's "Future milestones"
  -- section) land as new filenames without a migration.
  template      text not null,

  to_email      text not null,

  status        text not null default 'pending'
                check (status in ('pending', 'sent', 'skipped')),

  -- Set when status = 'pending' and the send was deferred to the next
  -- in-window run (queued outside 7am-7pm Adelaide, or a same-window
  -- send that failed and was queued for retry). Null once sent/skipped.
  scheduled_for timestamptz,
  sent_at       timestamptz,

  -- Merge-data snapshot (first_name, last_name, visit_date, visit_time,
  -- suburb, phillip_phone, subject, visit_datetime — see module doc
  -- comment above). Defaults to '{}' rather than null so callers never
  -- need a null-check before reading a key off it.
  detail        jsonb not null default '{}'::jsonb,

  created_at    timestamptz not null default now()
);

-- Primary lookup shape: "every send logged for this record + template"
-- (the re-send guard's own query, and the "last-sent chip" surfaced on
-- LeadDetailPanel / ClientEventsPanel via GET /api/visit-emails).
create index if not exists idx_email_sends_record_template
  on email_sends(record_type, record_id, template);

-- Supports the cron flush pass's "every due pending row" query.
create index if not exists idx_email_sends_pending_due
  on email_sends(status, scheduled_for) where status = 'pending';

alter table email_sends enable row level security;

drop policy if exists "team_all" on email_sends;
create policy "team_all" on email_sends
  for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
