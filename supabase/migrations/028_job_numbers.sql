-- ============================================================
-- RESLU Spec System — Auto job numbers.
-- BUILD-SPEC.md "Three from Phillip — 6 July 2026 evening" item 2:
-- "projects.job_number text unique — auto-generated 3-digit on create
-- (next = max numeric existing + 1, zero-padded; their convention:
-- Goldsworthy = 026). Overridable in project Settings (unique-checked,
-- 409 on clash). ... Backfill existing projects sequentially by
-- created_at, Goldsworthy manually set to 026 (its real number)."
--
-- Conventions carried over from prior migrations (020/026/027):
--   - idempotent (add column if not exists / create index if not
--     exists) so a partial apply converges cleanly on re-run
--   - RLS is untouched here — job_number is just another column on the
--     existing `projects` row, already covered by that table's
--     "team_all" policy (001_initial.sql); no new table, no new policy
--     needed
--   - text, not integer: matches every other human-facing code in this
--     schema (items.item_code, categories.prefix) — zero-padding and
--     the "roll to 4 digits past 999" behaviour (BUILD-SPEC.md: "next =
--     max numeric existing + 1, zero-padded") are display/generation
--     concerns handled in lib/job-number.ts, not a DB numeric type.
--
-- File-boundary note: owned entirely by this task. Only touches
-- `projects` (additive column + index); does not touch any table
-- another concurrent task owns.
-- ============================================================

alter table projects
  add column if not exists job_number text;

comment on column projects.job_number is
  'Internal job/project number (e.g. "026"), 3 digits zero-padded, rolling to 4 digits naturally once the sequence passes 999. Auto-generated on project creation (lib/job-number.ts nextJobNumber() — max of existing numeric job_numbers + 1) but overridable per project in Settings. Rendered on internal surfaces (project header, dashboard card) and externally on the FF&E schedule PDF + SOW PDF cover/footer ("Project No. 026") — unlike projects.alias, this one IS client/builder-facing by design (BUILD-SPEC.md: "future invoices ... can incorporate it"). See supabase/migrations/028_job_numbers.sql for the backfill that assigned the first batch.';

-- Partial unique index: a null job_number never collides with another
-- null (unassigned projects can coexist), and only active (non
-- soft-deleted) rows are checked — an archived/deleted project should
-- never block a live project from reusing its old number. Mirrors the
-- existing idx_items_project_code_active partial-unique pattern
-- (001_initial.sql).
create unique index if not exists idx_projects_job_number_active
  on projects(job_number)
  where job_number is not null and deleted_at is null;

-- ------------------------------------------------------------
-- Backfill — sequential by created_at, 3-digit zero-padded, starting
-- at '001', EXCEPT the project named 'Goldsworthy' (case-insensitive)
-- is set to '026' first and excluded from the sequence entirely — per
-- Phillip: "their convention: Goldsworthy = 026" is a REAL, already-
-- in-use job number (their own numbering system predates this
-- feature), not a placeholder to be overwritten by sequence position.
-- ------------------------------------------------------------

-- Step 1: Goldsworthy gets its real-world number directly, independent
-- of creation-date ordering. Only runs if such a project exists and
-- doesn't already have a job_number (idempotent re-run safety).
-- LIKE, not exact equality: the real project row is named "Goldsworthy
-- Virgo", not bare "Goldsworthy" — an exact match here silently matched
-- zero rows on the first apply (caught post-backfill, 7 July 2026: the
-- project had been assigned '001' by step 2 instead of its real '026'
-- until manually corrected). Matches step 2's exclusion below, which
-- has the same fix.
update projects
set job_number = '026'
where lower(name) like '%goldsworthy%'
  and job_number is null;

-- Step 2: every other project (explicitly excluding Goldsworthy, even
-- if step 1 above matched nothing — e.g. it was already numbered by a
-- prior partial run) gets the next sequential 3-digit number in
-- created_at order, skipping numbers already taken (so a re-run, or a
-- project manually numbered ahead of time, is never double-assigned).
do $$
declare
  rec record;
  next_num integer := 1;
  candidate text;
begin
  for rec in
    select id
    from projects
    where job_number is null
      and lower(name) not like '%goldsworthy%'
    order by created_at asc
  loop
    -- Advance past any number already in use (e.g. '026' from step 1,
    -- or any pre-existing manually-assigned job_number) so the
    -- sequence never collides with a taken value.
    loop
      candidate := lpad(next_num::text, 3, '0');
      exit when not exists (
        select 1 from projects where job_number = candidate
      );
      next_num := next_num + 1;
    end loop;

    update projects set job_number = candidate where id = rec.id;
    next_num := next_num + 1;
  end loop;
end $$;

notify pgrst, 'reload schema';
