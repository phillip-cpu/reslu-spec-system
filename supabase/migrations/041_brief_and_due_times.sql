-- ============================================================
-- RESLU Spec System — Daily Brief + reminder times
-- BUILD-SPEC.md §"Daily Brief (Phillip, 8 July 2026 — build with
-- migration 033 round)" + §"Small pair — 8 July 2026" item 2 (due_time).
--
-- FILE-NUMBER NOTE: this task's brief named the target file
-- "supabase/migrations/033_brief_and_due_times.sql" on the assumption
-- that migrations 001-032 were the full set in this working copy. That
-- is stale — this working copy already carries migrations up to 040
-- (033_aria_queue.sql, 034_aria_queue_claim_fn.sql,
-- 035_workspace_index.sql, 036_hybrid_search.sql, 037_emails.sql,
-- 038_email_extraction.sql, 039_entity_matching.sql,
-- 040_change_proposals.sql — the RESLU Second Brain rounds, run in this
-- copy after this task's brief was written). Overwriting
-- 033_aria_queue.sql would destroy a real, already-applied migration.
-- This file is instead the correct NEXT number, 041, per this
-- codebase's own numbering convention (see every prior migration) —
-- flagged here and in this round's final report for the reviewing
-- manager rather than silently deviating from the brief unremarked.
--
-- SECOND DEVIATION NOTE (schema, not just the filename): the brief's
-- daily_brief_items column list gives `converted_task_id uuid null
-- references board_tasks` as the ONLY "what did this item turn into"
-- column. That works cleanly for the "Add to project ->" path (creates
-- a real board_tasks row, converted_task_id references it directly).
-- But the brief ALSO specifies a second convert outcome — "no project
-- chosen -> office task in the 'Phillip' group" — and an office task
-- lives in office_tasks, a DIFFERENT table converted_task_id's FK
-- cannot point at (inserting an office_tasks id into a column that
-- references board_tasks(id) would either violate the FK constraint
-- outright, or silently collide with an unrelated board_tasks row that
-- happens to share that uuid — both unacceptable). Without a second
-- pointer, the office-conversion path would be INDISTINGUISHABLE from
-- a plain manual tick (both end up status='done', acknowledged_at
-- set) — which breaks the brief's own explicit requirement that a
-- converted item shows an "added to {project}" / "added to Office"
-- label inline. `converted_office_task_id uuid null references
-- office_tasks(id)` is added below to close this gap — additive, only
-- ever populated by the office-conversion branch of POST
-- /api/brief/items/[id]/convert, and (like converted_task_id itself)
-- purely a display pointer, never read by any dedupe/generation logic.
--
-- Three independent, additive pieces sharing one migration file (per
-- the brief's own "Also in migration 033: due_time ... per the 'Small
-- pair' spec item 2" instruction):
--
--   PART 1 — daily_brief_items: the new table backing the Daily Brief
--   panel (My Work page, mounted above the existing groups), plus the
--   converted_office_task_id addition explained above.
--   PART 2 — due_time: a nullable `time` column added to board_tasks,
--   office_tasks, and design_tasks for reminder-time-of-day parity.
--
-- Conventions carried over from every prior migration (040 most
-- recently): uuid pks via gen_random_uuid(), RLS via a single
-- permissive "team_all" policy per table (Phase 1 — "no unenforced
-- role theatre"; nothing in this migration is financial — brief items
-- reference admin-only-SOURCED data like leads/ordering, but the row
-- itself is just a title/link/status, same non-financial shape as
-- office_tasks), idempotent throughout (create table if not exists /
-- add column if not exists / drop+recreate policies) so a partial
-- apply converges cleanly on re-run.
-- ============================================================

-- ============================================================
-- PART 1 — daily_brief_items
-- BUILD-SPEC.md "Daily Brief" schema, verbatim column list, PLUS
-- `user_id uuid null` per the brief's own "Per-user? v1: single-team
-- brief (Phillip's) — user_id uuid null for future" note (the column
-- exists now, unused by v1's single shared brief, so a later per-user
-- brief needs no migration of its own — only a WHERE clause).
--
-- Deliberately NOT modelling a `note` column for the "added to
-- {project}" inline label the brief's item-actions section describes —
-- that label is fully derivable at render time from
-- converted_task_id + project_id (both already on this row once a
-- convert action runs), so storing a second, potentially-stale text
-- copy of the same fact would be redundant. See
-- app/api/brief/items/[id]/convert/route.ts and
-- components/my-work/DailyBrief.tsx for where that label is computed.
-- ============================================================
create table if not exists daily_brief_items (
  id                 uuid primary key default gen_random_uuid(),
  brief_date         date not null default current_date,
  title              text not null,
  source             text not null check (source in ('booking', 'ordering', 'lead', 'trade', 'email', 'invoice', 'manual', 'aria')),
  link_href          text,
  status             text not null default 'open' check (status in ('open', 'done')),
  acknowledged_at    timestamptz,
  created_by_kind    text not null default 'system' check (created_by_kind in ('system', 'aria', 'user')),
  created_by         uuid references profiles(id) on delete set null,
  converted_task_id  uuid references board_tasks(id) on delete set null,
  -- See this migration's own "SECOND DEVIATION NOTE" header comment —
  -- the office-conversion sibling of converted_task_id, needed because
  -- an office task lives in a different table converted_task_id's FK
  -- cannot reference.
  converted_office_task_id uuid references office_tasks(id) on delete set null,
  project_id         uuid references projects(id) on delete set null,
  -- Per-user brief, v1 stays single-team (Phillip's shared brief) — see
  -- this PART's own header comment. Nullable and unused by any query in
  -- this round; a future per-user brief scopes GET /api/brief by this
  -- column without a new migration.
  user_id            uuid references profiles(id) on delete set null,
  created_at         timestamptz not null default now()
);

-- Dedupe lookup (generator's own "skip when an OPEN item exists with
-- the same source+link_href within the last 7 days" rule) and the
-- panel's "every open item regardless of brief_date, most recent
-- first" query both hinge on (status, source, link_href) and
-- (status, brief_date) respectively — two targeted indexes rather than
-- one wide composite, since the two query shapes don't share a common
-- leading-column prefix.
create index if not exists idx_daily_brief_items_dedupe on daily_brief_items (source, link_href, status, brief_date);
create index if not exists idx_daily_brief_items_status_date on daily_brief_items (status, brief_date desc);
create index if not exists idx_daily_brief_items_project on daily_brief_items (project_id);

comment on table daily_brief_items is
  'Daily Brief — BUILD-SPEC.md "Daily Brief": a sticky-note acknowledgement layer on top of the existing attention feeds (bookings_overdue, ordering_due, lead nurture/stale, trade proposed_change, expiring insurance) plus manual/Aria-appended items. Ticking an item means "seen/handled" — it NEVER completes the underlying record; deep links (link_href) are how you action the real thing. v1 is a single shared team brief (Phillip reviews it each morning), not per-user — see user_id doc comment.';
comment on column daily_brief_items.source is
  'booking = bookings_overdue (unconfirmed trade booking chase); ordering = order-by engine ordering_due rollup; lead = leads nurture/stale_proposals; trade = trade proposed_change OR expiring/expired insurance (both are trade-relationship data, no separate source value per BUILD-SPEC''s own "use ''trade''" instruction for insurance); email/invoice = reserved for a future email-pipeline/invoice-queue generator source, not populated by this round''s generator; manual = typed inline on the panel; aria = appended via the add_brief_item MCP tool.';
comment on column daily_brief_items.link_href is
  'Deep link to the real record this item is a reminder about (board focus id, P&P filtered view, /leads, /contacts, etc.) — "open ->" on the panel. Also the dedupe key alongside source+brief_date (see the generator route''s own doc comment).';
comment on column daily_brief_items.converted_task_id is
  'Set by POST /api/brief/items/[id]/convert when "Add to project ->" creates a board_tasks row from this item. Null for every item never converted (the common case) and for items converted to an OFFICE task instead — see converted_office_task_id (this migration''s own "SECOND DEVIATION NOTE") for that sibling case.';
comment on column daily_brief_items.converted_office_task_id is
  'Set by POST /api/brief/items/[id]/convert when the "no project chosen" path creates an office_tasks row (Phillip group) from this item instead of a board task. Mutually exclusive with converted_task_id — a given brief item is converted to at most one of the two. See this migration''s own "SECOND DEVIATION NOTE" header comment for why a second FK column exists here rather than overloading converted_task_id.';

alter table daily_brief_items enable row level security;

drop policy if exists "team_all" on daily_brief_items;
create policy "team_all" on daily_brief_items
  for all to authenticated using (true) with check (true);

-- ============================================================
-- PART 2 — due_time (Small pair, item 2)
-- BUILD-SPEC.md: "board_tasks (+ office_tasks, design_tasks for
-- parity) gain due_time time null; due editors offer an optional time
-- beside the date; My Work sorts same-day items by time and shows
-- '2:30pm' on the line; overdue turns red by datetime when time
-- present, else by date."
--
-- Plain nullable `time` column (no timezone — a wall-clock reminder
-- time paired with the existing date-only due_date column, same
-- date/time split every other date-only column in this schema uses;
-- see lib/order-by.ts's own "date-only, no time-of-day" module comment
-- for why due_date itself stays a plain date). No RLS change needed —
-- these three tables already carry their own "team_all" policy from
-- migrations 013/020/021/025; adding a column doesn't touch policy
-- scope.
-- ============================================================
alter table board_tasks add column if not exists due_time time;
alter table office_tasks add column if not exists due_time time;
alter table design_tasks add column if not exists due_time time;

comment on column board_tasks.due_time is
  'Optional wall-clock reminder time alongside due_date (migration 041, "Small pair" item 2). Null = date-only due (the pre-existing behaviour). When set, My Work/board overdue styling compares against the full due_date+due_time instant rather than just the calendar date.';
comment on column office_tasks.due_time is
  'Optional wall-clock reminder time alongside due_date (migration 041, "Small pair" item 2) — parity with board_tasks.due_time, see that column''s comment.';
comment on column design_tasks.due_time is
  'Optional wall-clock reminder time alongside due_date (migration 041, "Small pair" item 2) — parity with board_tasks.due_time, see that column''s comment.';

notify pgrst, 'reload schema';
