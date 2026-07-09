-- ============================================================
-- RESLU Spec System — Lead flow round
-- docs/RESLU-lead-flow-brief.md + docs/DESIGNER-NOTES.md: wires the
-- designer-built "paper card" client journey (real visit-confirmation
-- .html / visit-reminder.html templates + the project-brief.html
-- pre-visit questionnaire, staged in emails/) into the r15 site-visit-
-- emails machinery (migration 043_visit_emails.sql, lib/visit-emails.ts)
-- rather than forking a second send pipeline.
--
-- NOTE ON BUILD-SPEC.md: this round's task brief also cites "BUILD-
-- SPEC.md section 'Lead flow package'" as a reconciliation source
-- alongside docs/RESLU-lead-flow-brief.md and docs/DESIGNER-NOTES.md —
-- no file named BUILD-SPEC.md exists anywhere in this working copy
-- (checked: `find . -iname "*build*spec*"` returns nothing, and
-- `docs/` has no such file either). This migration, and every other
-- file in this round, follow docs/RESLU-lead-flow-brief.md +
-- DESIGNER-NOTES.md's own CORRECTIONS section as the sole authoritative
-- brief — same "flag the discrepancy in the migration + final report,
-- don't silently deviate or invent content" convention migration 041's
-- own file-number note set. Flagged again in this round's final report
-- for the reviewing manager.
--
-- Two independent, additive pieces on the existing `leads` table:
--   1. brief_token / brief_answers / brief_submitted_at — backs the
--      tokenised /brief/[token] questionnaire page (GET /brief/[token],
--      POST /api/brief-submit/[token]).
--   2. visit_ics_sequence — RFC 5545 SEQUENCE bookkeeping for the
--      invite.ics attached to visit-confirmation.html / visit-
--      reminder.html sends (lib/ics.ts's generateVisitIcs()).
--      trade_visits' own, separate document-pack/ICS story
--      (app/api/trade/[token]/**) is untouched — this column is
--      lead-site-visit-specific.
--
-- Conventions carried over from every prior migration: idempotent
-- (add column if not exists) so a partial apply converges cleanly on
-- re-run. No RLS change needed — both additions are plain columns on
-- the existing `leads` table, already covered by migration 014's
-- "team_all" policy for authenticated team access; the public
-- /brief/[token] page and its submit route use the SERVICE-ROLE client
-- instead (same trust model as /trade/[token] and /portal/[token] —
-- RLS is never the security boundary for those, the unguessable token
-- is the boundary, same as here).
-- ============================================================

alter table leads add column if not exists brief_token text unique;
alter table leads add column if not exists brief_answers jsonb;
alter table leads add column if not exists brief_submitted_at timestamptz;
alter table leads add column if not exists visit_ics_sequence int not null default 0;

comment on column leads.brief_token is
  'Unguessable token (64-char hex, crypto.randomBytes(32) — same shape as projects.client_token / trade_visits.confirm_token) for the public /brief/[token] pre-visit questionnaire page. Generated LAZILY (lib/lead-brief.ts''s ensureBriefToken()) the first time a visit-reminder email needs to merge {{brief_link}} for this lead, not at lead creation. Null until then.';
comment on column leads.brief_answers is
  'The 10 fields emails/brief/project-brief.html''s <form> posts (first_name, last_name, hoping, favourite_spaces, materials, feel, must_1, must_2, must_3, bringing), stored verbatim via POST /api/brief-submit/[token]. A re-submission overwrites this in full (idempotent by design — the client-side page has no server-synced draft state to reconcile), with the PRIOR submission''s timestamp kept as a "_previous_submitted_at" note inside the new jsonb blob so a double-submit is visible on the lead record rather than silently lost.';
comment on column leads.brief_submitted_at is
  'Set (and re-set, on every re-submission) by POST /api/brief-submit/[token]. Null = never submitted. Drives LeadDetailPanel''s "Project brief" section render and the direct daily_brief_items "Brief submitted — {lead}" insert on first submit.';
comment on column leads.visit_ics_sequence is
  'RFC 5545 SEQUENCE for this lead''s site-visit invite.ics (lib/ics.ts''s generateVisitIcs(), stable UID lead-visit-{lead_id}@reslu.com.au) — starts at 0, incremented by 1 via increment_visit_ics_sequence() each time site_visit_date CHANGES to a new non-null value on an ALREADY-booked visit (a reschedule), so recipients'' calendar apps update the existing event in place instead of duplicating it. NOT incremented on a first booking (previous value was null) or on cancellation (site_visit_date cleared — no invite send happens then, nothing to update in place).';

-- Atomic read-modify-write for visit_ics_sequence. A plain
-- select-then-update from app/api/leads/[id]/route.ts's after()
-- callback is a real race: two reschedule PATCHes landing close
-- together can both read the same pre-increment value and both write
-- the same SEQUENCE, which RFC 5545 requires to be unique per update —
-- calendar apps may then silently drop one of the two changes. This
-- function does the increment inside a single statement so Postgres's
-- own row lock serializes concurrent callers instead of racing.
create or replace function increment_visit_ics_sequence(p_lead_id uuid)
returns int
language sql
as $$
  update leads
  set visit_ics_sequence = visit_ics_sequence + 1
  where id = p_lead_id
  returning visit_ics_sequence;
$$;

comment on function increment_visit_ics_sequence(uuid) is
  'Lead flow round (048) fix. Atomically increments and returns leads.visit_ics_sequence for a reschedule — see the column comment above. Called from app/api/leads/[id]/route.ts instead of a select-then-update to avoid a lost-update race between two near-simultaneous reschedules of the same lead.';

notify pgrst, 'reload schema';
