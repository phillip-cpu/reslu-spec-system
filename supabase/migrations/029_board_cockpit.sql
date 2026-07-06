-- ============================================================
-- RESLU Spec System — Board cockpit round (7 July 2026).
-- BUILD-SPEC.md "Board refinement batch (Phillip screenshots, 7 July
-- 2026)" items 1-9 + the four chat-agreed improvements: book-trade-
-- from-card (visit_id linkage + live status badge), milestone cards
-- (kind + diary-on-complete), phase task templates (app_settings
-- 'phase_task_templates'), Aria booking-chase attention feed
-- ('bookings_overdue') + two-dates-per-card (booking_date/
-- booking_end_date distinct from due_date).
--
-- Conventions carried over from every prior migration (016/020/023
-- most recently):
--   - uuid pks via gen_random_uuid()
--   - set_updated_at() trigger helper (defined in 001) reused, not
--     redefined
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"; none of this round's data is
--     financial)
--   - soft delete via nullable deleted_at where the spec calls for it
--   - idempotent throughout (add column if not exists / create table
--     if not exists / drop+recreate triggers & policies / on conflict
--     do nothing) so a partial apply converges cleanly on re-run —
--     this migration has never run anywhere yet, but every prior
--     migration in this schema follows this discipline regardless, and
--     there is no reason to be the first exception.
-- ============================================================

-- ============================================================
-- PART 1 — board_tasks additions: kind (milestone), visit_id linkage,
-- booking_date/booking_end_date.
--
-- kind: a FRESH column/constraint, deliberately NOT reusing
-- schedule_phases.kind's check constraint ('phase'|'umbrella') or
-- office_tasks.kind's ('task'|'rule') — those are different domains
-- with their own fixed enums; board_tasks needs its own
-- ('task'|'milestone') pair. Defaults to 'task' so every existing row
-- (and every ordinary new card) is unaffected.
--
-- visit_id: nullable FK to trade_visits, ON DELETE SET NULL — mirrors
-- board_tasks.contact_id's exact "optional link, never cascades" shape
-- (013_boards_contacts.sql). A card can exist with no trade booked yet
-- (visit_id null); "Book trade" (see app/api/board-tasks/[id]/
-- book-visit/route.ts, this round) creates the trade_visits row AND
-- sets this column in one step. Deleting the linked visit later (rare
-- — visits are soft-deleted like everything else, never hard-deleted
-- in normal use) must not take the card down with it — the card simply
-- loses its live status badge and reverts to "no booking" display.
--
-- booking_date / booking_end_date: the BOOKING window, distinct from
-- due_date (the task's own deadline) per this round's brief
-- ("two-dates-per-card booking_date/booking_end_date + due_date
-- distinct display"). Deliberately DENORMALIZED copies of the linked
-- trade_visits.start_date/end_date rather than purely-derived-via-join
-- columns: the Board's kanban/grouped-list card rendering needs to
-- read booking dates from the SAME single board_tasks query it already
-- runs (GET /api/projects/[id]/board already selects board_tasks in
-- bulk across every column — adding a per-card trade_visits join would
-- mean N+1 lookups keyed by visit_id, or a second bulk query the route
-- would need to merge in by hand). Since a card's booking window
-- rarely changes except via the "Book trade" action or a Timeline drag
-- of the SAME visit, keeping these two columns in sync at the two
-- write sites (POST .../book-visit on this round, PATCH /api/visits/
-- [id] when the linked task exists) is a small, bounded amount of
-- sync logic in exchange for zero N+1 reads on every board load — see
-- those routes' own doc comments for exactly where the sync happens.
-- ============================================================
alter table board_tasks
  add column if not exists kind text not null default 'task' check (kind in ('task', 'milestone'));

alter table board_tasks
  add column if not exists visit_id uuid references trade_visits(id) on delete set null;

alter table board_tasks
  add column if not exists booking_date date;

alter table board_tasks
  add column if not exists booking_end_date date;

alter table board_tasks
  drop constraint if exists chk_board_tasks_booking_dates;
alter table board_tasks
  add constraint chk_board_tasks_booking_dates
    check (booking_end_date is null or booking_date is null or booking_end_date >= booking_date);

create index if not exists idx_board_tasks_visit on board_tasks(visit_id);
create index if not exists idx_board_tasks_kind on board_tasks(kind);
-- Supports the bookings_overdue attention feed's "booked, not yet
-- confirmed/complete, booking_date in the past" query.
create index if not exists idx_board_tasks_booking_date on board_tasks(booking_date) where deleted_at is null;

comment on column board_tasks.kind is
  'Board cockpit round (migration 029). ''task'' (default) is an ordinary card; ''milestone'' renders as a diamond marker on the Gantt timeline (see lib/gantt.ts milestoneGridPosition + components/gantt/GanttChart.tsx) and, on being moved to a Done-like column, prompts staff to create a diary entry (portal_updates) — see components/board/ProjectBoard.tsx''s milestone-complete prompt and docs/API.md "Board cockpit round" for the exact trigger condition (column name match, not a fixed column_id, since column sets are per-project/editable).';

comment on column board_tasks.visit_id is
  'Board cockpit round (migration 029). Links a card to the trade_visits row booked from it via POST /api/board-tasks/[id]/book-visit. Nullable + ON DELETE SET NULL, same discipline as board_tasks.contact_id (013_boards_contacts.sql) — losing the linked visit degrades the card''s status badge, it never deletes the card. A card can also be manually linked to an EXISTING visit rather than creating a new one (see that route''s body shape).';

comment on column board_tasks.booking_date is
  'Board cockpit round (migration 029). The booked trade-visit window''s start (denormalized copy of trade_visits.start_date for visit_id, kept in sync at the write sites — see this migration''s PART 1 header comment for the full rationale). Distinct from due_date (the task''s own deadline) — a card can have both, either, or neither. Null when visit_id is null.';

comment on column board_tasks.booking_end_date is
  'Board cockpit round (migration 029). Companion to booking_date — the booked trade-visit window''s end (denormalized copy of trade_visits.end_date). See booking_date''s own comment for the full sync-site rationale.';

-- ============================================================
-- PART 2 — Phase task templates: a second app_settings key,
-- 'phase_task_templates', alongside the existing 'phase_template' key
-- (023_phases_insurance.sql) — SAME table, no new schema, per that
-- table's own "deliberately generic jsonb value so a future second
-- setting doesn't need its own migration" design note.
--
-- Shape: a jsonb OBJECT keyed by phase template NAME (matching
-- app_settings('phase_template') row names, e.g. "Demolition") ->
-- array of { title, kind }. Keyed by name rather than by a phase
-- template row's own id, because the phase template itself has no
-- stable id of its own (it's a flat jsonb array, migration 023) —
-- name is already the de facto identity for template rows (see
-- lib/phase-template.ts's namesMatch()), so reusing it here avoids
-- introducing a second identity scheme for the same conceptual list.
-- Seeded with ONE sensible default checklist, for "Site Setup" only
-- (the umbrella phase every phase template ships with, per
-- FALLBACK_PHASE_TEMPLATE/migration 023) — every other phase name
-- starts with no checklist (an absent key, same as `rowsFor()` in
-- components/settings/PhaseTaskTemplateSettings.tsx treating a missing
-- key as `[]`), since this migration has no basis for guessing a
-- "typical" checklist for Demolition/Rough-in/etc. without inventing
-- data nobody asked for (lib/calculators.ts, Round B, established this
-- discipline). Site Setup is the one exception: BUILD-SPEC.md's own
-- "Scale" note (5 Jul) is explicit about what belongs to it — "site
-- establishment, fencing, amenities, skips" — describing the
-- Preliminaries & Site cost-section lines its umbrella band already
-- shows read-only (migration 016's cost_section_lines). Turning that
-- SAME short, already-spec'd list into a first-run task checklist is a
-- direct, minimal reflection of what the spec already says belongs to
-- this phase, not a guess — Phillip/team can freely edit or clear it
-- via the Settings editor afterwards like any other phase's checklist.
-- ============================================================
insert into app_settings (key, value)
values (
  'phase_task_templates',
  '{
    "Site Setup": [
      { "title": "Site fencing delivered and installed", "kind": "task" },
      { "title": "Site toilet delivered", "kind": "task" },
      { "title": "Skip bin delivered", "kind": "task" },
      { "title": "Site signage installed", "kind": "task" }
    ]
  }'::jsonb
)
on conflict (key) do nothing;

notify pgrst, 'reload schema';

-- ============================================================
-- PART 3 — materials price-refresh failure state ("needs_aria").
--
-- Bunnings/Wilbrad-type supplier pages hang or reject plain server-side
-- fetch (VERIFIED, not hypothetical — see BUILD-SPEC.md; both
-- bunnings.com.au and wilbrad.com.au have been observed to hang on a
-- bare fetch from the refresh-price route). Rather than the route
-- silently failing or looping, it now records that a price refresh was
-- requested but couldn't complete automatically, so Aria (via MCP tool
-- submit_material_price, this round) or a human can pick it up.
--
-- price_refresh_status: nullable, single allowed non-null value
-- 'needs_aria' (a proper enum table felt like overkill for a single
-- flag — same "don't over-model a boolean-shaped thing" judgement as
-- office_tasks elsewhere in this schema). Null = no outstanding
-- request (either never refreshed, or last refresh succeeded and
-- cleared this column back to null). Set by app/api/materials/[id]/
-- refresh-price/route.ts on fetch failure/timeout; cleared by that
-- same route on the next successful refresh AND by the MCP tool
-- submit_material_price (Aria supplying a price manually resolves the
-- outstanding request the same way a successful scrape would).
--
-- price_refresh_requested_at: when the failed refresh attempt (that
-- set price_refresh_status) happened — feeds the 'price_refreshes_pending'
-- attention feed group (lib/board-cockpit.ts's computeMaterialsNeedingAria(),
-- surfaced via GET /api/materials/attention — same thin-lib-function +
-- thin-route shape as this migration's own 'bookings_overdue', this
-- round) so stale requests surface with an age.
-- ============================================================
alter table materials
  add column if not exists price_refresh_status text
    check (price_refresh_status is null or price_refresh_status in ('needs_aria'));

alter table materials
  add column if not exists price_refresh_requested_at timestamptz;

create index if not exists idx_materials_price_refresh_status on materials(price_refresh_status) where price_refresh_status is not null;

comment on column materials.price_refresh_status is
  'Board cockpit round (migration 029). Null = no outstanding refresh request. ''needs_aria'' = the last automated scrape (POST /api/materials/[id]/refresh-price) failed/timed out (Bunnings/Wilbrad-type pages hang on plain fetch) and is waiting on Aria or a human to supply a price via MCP tool submit_material_price or the Materials UI. Cleared back to null on next successful refresh or manual submission.';

comment on column materials.price_refresh_requested_at is
  'Board cockpit round (migration 029). Timestamp of the failed refresh attempt that set price_refresh_status=''needs_aria''. Feeds the ''price_refreshes_pending'' attention feed group (lib/board-cockpit.ts computeMaterialsNeedingAria(), surfaced via GET /api/materials/attention). Null whenever price_refresh_status is null.';

notify pgrst, 'reload schema';
