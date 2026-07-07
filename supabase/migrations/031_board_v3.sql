-- ============================================================
-- RESLU Spec System — Board v3 — Monday parity round.
-- BUILD-SPEC.md "Board v3 — Monday parity" §2 "Sub-item support:
-- board_tasks gain parent_task_id (migration 031)".
--
-- Conventions carried over from every prior migration (029/030 most
-- recently):
--   - uuid pks via gen_random_uuid()
--   - RLS: single permissive "team_all" policy per table (Phase 1 —
--     "no unenforced role theatre"); board_tasks already carries this
--     policy from migration 013, unaffected by an added column
--   - idempotent throughout (add column if not exists / create index
--     if not exists) so a partial apply converges cleanly on re-run —
--     same discipline every prior migration in this schema follows
--
-- Scope: ONE new column, nothing else. The 13-stage template content,
-- the default status-column seed reorder/recolour, the Grouped-list
-- visual rebuild, and the dependency chips are all application-layer
-- (lib/phase-template.ts, lib/board-constants.ts,
-- components/board/ProjectBoard.tsx) — no schema of their own, per
-- this round's own "no schema changes" note on those items.
-- ============================================================

-- ============================================================
-- board_tasks.parent_task_id — sub-items ("Board v3 — Monday
-- parity" §2). One level of nesting ONLY: a sub-item's own
-- parent_task_id must point at a TOP-LEVEL task (a task whose own
-- parent_task_id is null). This depth limit is enforced in the API
-- layer (POST /api/projects/[id]/board — see that route's own doc
-- comment for the exact check), NOT via a DB trigger/check constraint
-- — same "app layer enforces business invariants, DB enforces
-- referential integrity" split this schema has used since migration
-- 029's board_tasks.visit_id comment (that column's "one active
-- booking at a time" rule is likewise app-enforced, not DB-unique-
-- enforced).
--
-- ON DELETE CASCADE (a hard-delete FK action) even though board_tasks
-- itself is soft-deleted (deleted_at) in normal operation — this only
-- fires on an actual hard DELETE of the parent row, which this schema
-- never does for board_tasks (every existing DELETE /api/board-tasks/
-- [id] route only ever sets deleted_at). The soft-delete case (a
-- parent's deleted_at being set) is handled at the API layer instead
-- — see DELETE /api/board-tasks/[id]'s updated doc comment: soft-
-- deleting a parent also soft-deletes its own children, so an orphaned
-- sub-item never keeps rendering under a parent that has disappeared
-- from the board. The CASCADE here is purely a safety net for the
-- hypothetical/administrative hard-delete case (e.g. a manual SQL
-- cleanup), consistent with every other parent-child FK in this schema
-- (e.g. board_columns -> board_tasks) using CASCADE for exactly that
-- reason.
--
-- Sub-items inherit phase_group_id from their parent at creation time
-- (application-layer copy, POST /api/projects/[id]/board) — this is
-- NOT a generated/computed column referencing the parent, since a
-- sub-item's phase_group_id is allowed to be independently updated
-- later exactly like any other board_tasks row (e.g. a drag-move),
-- same "denormalized copy, not a live derivation" pattern this schema
-- already uses for board_tasks.booking_date (migration 029).
-- ============================================================
alter table board_tasks
  add column if not exists parent_task_id uuid references board_tasks(id) on delete cascade;

create index if not exists idx_board_tasks_parent on board_tasks(parent_task_id);

comment on column board_tasks.parent_task_id is
  'Board v3 — Monday parity round (migration 031). Nullable self-FK — a sub-item ("Skirtings installation 2"-style) points at its top-level parent task. ONE LEVEL ONLY: a row whose parent_task_id is itself non-null must never be pointed at by another row''s parent_task_id — enforced in POST /api/projects/[id]/board (400 on an attempted depth-2 nest), not by a DB constraint, per this schema''s established app-layer-enforces-business-invariants split (see migration 029''s board_tasks.visit_id comment for the same discipline elsewhere in this table). Sub-items inherit their phase_group_id from the parent at creation time (a denormalized copy, independently editable afterwards — same pattern as booking_date). Sub-items are EXCLUDED from a group''s top-level "N items · M done" summary (GroupTable, components/board/ProjectBoard.tsx) — only parent-level/top-level tasks (parent_task_id is null) count toward that. Parent completion status is INDEPENDENT of its sub-items'' completion — there is no auto-rollup; a parent''s own column_id (status) never changes because its children changed. ON DELETE CASCADE is a hard-delete safety net only — normal deletes in this app are soft (deleted_at), and DELETE /api/board-tasks/[id] explicitly soft-deletes a parent''s children alongside it at the API layer.';

notify pgrst, 'reload schema';
