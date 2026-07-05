-- ============================================================
-- RESLU Spec System — Phase 11A: Trade confirmation engine +
-- Timeline v2 (umbrella phases).
-- BUILD-SPEC.md §"Phase 11 — Client portal v2 + trade confirmations"
-- (the trade-facing half) / §"Timeline v2".
--
-- File-boundary note: this agent owns this migration, components/
-- gantt/**, lib/gantt.ts, lib/trade-visits.ts, app/trade/**,
-- app/api/trade/**, app/api/visits/**, app/api/projects/[id]/visits/**.
-- The Phase 11B agent owns migration 016_portal_v2.sql (portal v2,
-- diary, gallery, notifications) concurrently in this same working
-- copy — that migration explicitly does not assume this one has
-- landed, and this migration does not touch any table 016 owns.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001_initial.sql)
--     reused, not redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"); trades/visits are scheduling
--     data, not financial, so there is no admin-gating requirement
--   - soft delete via nullable deleted_at, same as schedule_phases/
--     contacts/items
-- ============================================================

-- ============================================================
-- trade_visits — one row per scheduled/nominated trade visit inside a
-- schedule_phases row. A phase can hold many visits (e.g. "Plumbing
-- rough-in" phase has three separate plumber visits across the job).
--
-- Design choices:
--
-- - contact_id stays NULLABLE + ON DELETE SET NULL, mirroring the
--   existing precedent set by schedule_phases.contact_id in
--   013_boards_contacts.sql — a visit can be created before a trade is
--   assigned, and deleting a contact from the Address Book must not
--   cascade-delete every visit ever booked against them (that would
--   destroy real scheduling history over an address-book cleanup).
--
-- - confirm_token's default expression, encode(gen_random_bytes(32),
--   'hex'), is copied character-for-character from
--   projects.client_token in 001_initial.sql — the one other
--   unguessable-public-link token in this schema. Same trust model:
--   the token itself, not a hidden route, is the security boundary
--   for the public /trade/[token] page and its respond route (both
--   go through the service-role client, exactly like the portal).
--
-- - status / proposed_* are separate typed columns, not a jsonb blob.
--   The three-way trade response (confirm / confirm-different-time /
--   propose-another-day) needs its own CHECK-constrained enums
--   (arrival_slot, status) validated by Postgres itself, and every
--   other stateful, queryable column in this schema (items.status,
--   leads.stage, invoices.status, etc.) is a plain checked text
--   column — a jsonb blob here would be the only one of its kind and
--   would lose the DB-level enum guarantee for zero benefit (the
--   shape is fixed and small, not schemaless data).
--
-- - RLS is the same permissive "team_all" shape as every other table.
--   The public-facing /trade/[token] page and POST /api/trade/[token]/
--   respond route are NOT authenticated team sessions, so they read
--   and write via the SERVICE ROLE client (lib/supabase/server.ts's
--   createServiceRoleClient()), which bypasses RLS entirely — same
--   pattern as the client portal (see 001_initial.sql's closing
--   comment: "No anon-role policies are defined here on purpose").
--   The route handler itself is responsible for verifying the
--   confirm_token matches before acting, exactly like the portal's
--   client_token check.
-- ============================================================
create table if not exists trade_visits (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references projects(id) on delete cascade,
  phase_id          uuid not null references schedule_phases(id) on delete cascade,
  contact_id        uuid references contacts(id) on delete set null,

  start_date        date not null,
  end_date          date not null,

  arrival_slot      text check (arrival_slot in ('first_thing', 'midday', 'afternoon')),
  arrival_time      time,

  status            text not null default 'unconfirmed'
                    check (status in ('unconfirmed', 'confirmed', 'tentative', 'declined', 'proposed_change')),

  -- Trade-proposed alternative, set by the trade via the public
  -- respond route's "propose another day" action, or by staff via
  -- POST /api/visits/[id]/resolve-proposal's "counter" action (staff
  -- countering a trade's proposal overwrites these with the staff's
  -- own counter-offer — see that route's doc comment).
  proposed_start    date,
  proposed_end      date,
  proposed_slot     text check (proposed_slot in ('first_thing', 'midday', 'afternoon')),
  proposed_time     time,
  proposed_note     text,

  confirm_token     text not null unique default encode(gen_random_bytes(32), 'hex'),

  confirmed_at      timestamptz,
  confirmed_by      text check (confirmed_by in ('trade', 'staff')),

  -- Stamped by app/api/trade-reminders/route.ts once a reminder email
  -- actually sends (not stamped if Gmail is unconfigured and the send
  -- was skipped — see that route's doc comment — so an un-configured
  -- mailbox doesn't silently burn the one-time reminder).
  reminder_sent_at  timestamptz,

  notes             text,

  created_by        uuid references profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,

  constraint chk_trade_visits_dates check (end_date >= start_date)
);

create index if not exists idx_trade_visits_project on trade_visits(project_id);
create index if not exists idx_trade_visits_phase on trade_visits(phase_id);
-- confirm_token is already indexed by its unique constraint, but the
-- attention query (GET /api/visits/attention) and the reminder cron
-- (app/api/trade-reminders/route.ts) both filter on status + start_date
-- together, so a composite index serves both without a sequential scan
-- as trade_visits grows across many projects.
create index if not exists idx_trade_visits_status_start on trade_visits(status, start_date);
create index if not exists idx_trade_visits_deleted_at on trade_visits(deleted_at);

create trigger trg_trade_visits_updated_at
  before update on trade_visits
  for each row execute function set_updated_at();

alter table trade_visits enable row level security;

drop policy if exists "team_all" on trade_visits;
create policy "team_all" on trade_visits  for all to authenticated using (true) with check (true);

-- ============================================================
-- schedule_phases — Timeline v2 additions: kind + cost_section_id, for
-- the auto-maintained "Site Setup" umbrella band.
--
-- kind defaults to 'phase' (every existing row and every ordinary
-- team-created phase). 'umbrella' is a distinct row rendered as a
-- full-width band spanning the project's whole schedule (min/max of
-- every ordinary phase), representing whole-of-job preliminaries
-- (site fencing, toilet hire, etc. — the "Preliminaries & Site" cost
-- section) that don't belong to any single phase.
--
-- cost_section_id links an umbrella phase back to the cost_sections
-- row (migration 007_estimating.sql) whose line descriptions populate
-- its read-only info panel. Nullable + ON DELETE SET NULL because an
-- ordinary 'phase'-kind row never has one, and because a cost section
-- being deleted should not cascade-delete scheduling data — it should
-- just leave the umbrella phase's info panel pointing at nothing until
-- the next GET recomputes/removes it (see app/api/projects/[id]/
-- phases/route.ts's recompute-on-read doc comment for the full
-- lifecycle).
--
-- The umbrella row itself is NEVER created by this migration
-- (migration-time backfill would need to guess which project has a
-- "Preliminaries & Site" section with live lines, and would go stale
-- the moment anyone edited the estimate) — it is created, refreshed,
-- and soft-deleted entirely by application code on every
-- GET /api/projects/[id]/phases call, the same "seeded/maintained on
-- first read, not migration-time backfill" pattern
-- 013_boards_contacts.sql already established for board_columns.
-- ============================================================
alter table schedule_phases
  add column if not exists kind text not null default 'phase' check (kind in ('phase', 'umbrella'));

alter table schedule_phases
  add column if not exists cost_section_id uuid references cost_sections(id) on delete set null;

create index if not exists idx_schedule_phases_cost_section on schedule_phases(cost_section_id);
