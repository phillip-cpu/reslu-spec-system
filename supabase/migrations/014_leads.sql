-- ============================================================
-- RESLU Spec System — Week 10: Leads pipeline + Aria API layer
-- BUILD-SPEC.md §"Week 10 — Leads pipeline + Aria API layer" (5 July
-- 2026). Strategy note: the brief asked for live bidirectional Monday
-- sync; per the locked Monday-replacement strategy this migration's
-- `leads` table becomes the sole source of truth after a ONE-TIME
-- import (scripts/import-monday-leads.mjs), not an ongoing sync. No
-- code in this app ever reads Monday state back for leads.
--
-- Conventions carried over from every prior migration:
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not redefined
--   - soft delete via nullable deleted_at
--
-- Idempotent throughout (create ... if not exists / add column if not
-- exists / drop-then-create for triggers & policies) so it is safe to
-- re-run after a partial apply — the projects.lead_id ALTER can time out
-- against the live app's lock on that hot table and get skipped, and a
-- bare create-table/policy would then error on the retry. Re-running the
-- whole file always converges.
-- ============================================================

-- ============================================================
-- leads — surname_project card name, source, 10-stage pipeline, contact,
-- dates, admin-only financial-adjacent values, monday import provenance.
-- stage is text+CHECK (house style); array order below is pipeline order
-- (LeadsBoard.tsx renders kanban columns in this exact order).
-- ============================================================
create table if not exists leads (
  id                    uuid primary key default gen_random_uuid(),

  surname_project       text not null,
  first_name            text,

  source                text check (source in ('META', 'DIRECT')),

  stage                 text not null default 'Potential Lead'
                        check (stage in (
                          'Potential Lead',
                          'Site Visit Booked',
                          'Awaiting to Send Proposal',
                          'Proposal Sent',
                          'Design Work In Progress',
                          'Construction In Progress',
                          'Unable to Contact',
                          'Lead Lost',
                          'Complete',
                          'Potential Future Lead'
                        )),

  email                 text,
  phone                 text,
  location              text,

  received_at           timestamptz,
  follow_up_date         date,
  site_visit_date        timestamptz,
  site_visit_location    text,

  -- Admin-only financial-adjacent (whole leads surface is behind a
  -- route-level 403 for non-admins, like invoices/estimate).
  construction_value    numeric(12, 2),
  design_value          numeric(12, 2),

  design_start          date,
  design_end            date,
  construction_start    date,
  construction_end      date,

  -- Import provenance; unique so the one-time import can upsert on
  -- conflict without ever duplicating a lead. Nullable for native leads.
  monday_item_id        text unique,

  notes                 text,

  created_by            uuid references profiles(id) on delete set null,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  deleted_at            timestamptz,

  -- Lead ↔ project link (both directions stored: here, and
  -- projects.lead_id added below). "Create project" from the Design
  -- Work In Progress stage sets both.
  project_id            uuid references projects(id) on delete set null,

  constraint chk_leads_design_dates
    check (design_end is null or design_start is null or design_end >= design_start),
  constraint chk_leads_construction_dates
    check (construction_end is null or construction_start is null or construction_end >= construction_start)
);

create index if not exists idx_leads_stage on leads(stage);
create index if not exists idx_leads_follow_up_date on leads(follow_up_date);
create index if not exists idx_leads_deleted_at on leads(deleted_at);
create index if not exists idx_leads_project on leads(project_id);

drop trigger if exists trg_leads_updated_at on leads;
create trigger trg_leads_updated_at
  before update on leads
  for each row execute function set_updated_at();

-- Back-link from projects (both-ways link; nullable — legacy projects
-- have no lead behind them).
alter table projects
  add column if not exists lead_id uuid references leads(id) on delete set null;

create index if not exists idx_projects_lead on projects(lead_id);

-- ============================================================
-- lead_stage_events — append-only audit of every stage change (drives
-- avg-time-in-stage). Same shape as signature_events (insert+select only).
-- ============================================================
create table if not exists lead_stage_events (
  id          uuid primary key default gen_random_uuid(),
  lead_id     uuid not null references leads(id) on delete cascade,
  from_stage  text,
  to_stage    text not null,
  at          timestamptz not null default now()
);

create index if not exists idx_lead_stage_events_lead on lead_stage_events(lead_id, at);
create index if not exists idx_lead_stage_events_to_stage on lead_stage_events(to_stage, at);

-- Trigger writes an event on every stage change, for EVERY code path
-- (API, import script, future scripts) — no double/missed writes.
-- created_by omitted: a plain SQL trigger has no reliable app-user
-- context (auth.uid() is absent for the service-role import).
create or replace function log_lead_stage_change()
returns trigger as $$
begin
  if new.stage is distinct from old.stage then
    insert into lead_stage_events (lead_id, from_stage, to_stage, at)
    values (new.id, old.stage, new.stage, now());
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_leads_stage_change on leads;
create trigger trg_leads_stage_change
  after update on leads
  for each row execute function log_lead_stage_change();

-- ============================================================
-- Row Level Security — plain "team_all" (house style: RLS has never been
-- the admin boundary; admin enforcement for leads is a whole-route 403 in
-- app/api/leads/** via lib/auth.ts, same as invoices). Consistency, not a gap.
-- ============================================================
alter table leads enable row level security;
alter table lead_stage_events enable row level security;

drop policy if exists "team_all" on leads;
create policy "team_all" on leads
  for all to authenticated using (true) with check (true);

-- Append-only audit: insert + select only, no update/delete policy.
drop policy if exists "lead_stage_events_insert" on lead_stage_events;
create policy "lead_stage_events_insert" on lead_stage_events
  for insert to authenticated with check (true);
drop policy if exists "lead_stage_events_select" on lead_stage_events;
create policy "lead_stage_events_select" on lead_stage_events
  for select to authenticated using (true);

notify pgrst, 'reload schema';
