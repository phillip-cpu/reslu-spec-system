// ============================================================
// RESLU Spec System — Board v3 — Monday parity round LOCAL types.
// BUILD-SPEC.md "Board v3 — Monday parity".
//
// Deliberately NOT added to types/index.ts (protected for this round
// — see the file-boundary list) or types/phase-12a-b.ts / 
// types/board-cockpit.ts (prior, already-completed rounds' own files)
// — follows the identical per-round-own-file convention every
// phase-N.ts / round-*.ts / board-cockpit.ts file in this directory
// already uses (see types/phase-fix-a.ts's header comment for the
// fullest statement of the rationale). Everything below is scoped to
// this round's own files: supabase/migrations/031_board_v3.sql,
// components/board/ProjectBoard.tsx, lib/board-constants.ts,
// lib/phase-seed.ts, app/api/projects/[id]/board/**,
// app/api/board-tasks/**.
//
// Cross-imports from types/index.ts / types/phase-12a-b.ts /
// types/board-cockpit.ts are READ-ONLY reuse of existing,
// already-defined shapes — nothing in any of those three files is
// modified.
// ============================================================

import type { BoardTaskCockpit, BoardColumnCockpit, BoardGroupCockpit } from "@/types/board-cockpit";
import type { AssigneeSummary } from "@/types/phase-12a-b";

// ------------------------------------------------------------
// Sub-items (board_tasks.parent_task_id, migration 031)
//
// MODEL CHOICE — FLAT, not nested: GET /api/projects/[id]/board
// continues to return every non-deleted board_tasks row (sub-items
// included) as a single flat list per column/group, each row now
// additionally carrying `parent_task_id`. The client
// (components/board/ProjectBoard.tsx) groups sub-items under their
// parent itself, by filtering on `parent_task_id` client-side, rather
// than the API embedding a `children: BoardTaskV3[]` array on each
// parent row.
//
// WHY: "least disruption to the EXISTING GET response shape" (this
// round's own explicit tie-breaker) — the current shape is a flat
// `tasks: BoardTaskCockpit[]` array per column AND per group (see
// BoardColumnCockpit/BoardGroupCockpit, types/board-cockpit.ts), and
// EVERY existing consumer of that shape (GroupRows, UngroupedTable,
// StackedColumnSection, BoardCard, the Kanban drag-and-drop sort-ladder
// math in ProjectBoard.tsx's onDrop/onDropInGroup) already assumes a
// flat array of siblings it can sort/splice/filter by `sort` — a
// nested `children[]` would require every one of those call sites to
// be taught to recurse, INCLUDING the sort-ladder reorder math, which
// deliberately must NEVER apply across parent/child boundaries anyway
// (BUILD-SPEC.md: "sub-items only reorder within their own sibling
// set"). Keeping the wire shape flat and doing the parent/child
// grouping in ONE place client-side (GroupRows) is a strictly smaller,
// additive change than teaching every existing consumer to expect
// nesting.
// ------------------------------------------------------------

/** A BoardTaskCockpit (types/board-cockpit.ts, Board cockpit round) extended with this round's parent_task_id. Layered as an intersection rather than editing that type directly, per this file's own edit-boundary discipline. */
export type BoardTaskV3 = BoardTaskCockpit & {
  parent_task_id: string | null;
};

/** body accepted by POST /api/projects/[id]/board (Board v3 addition) — parent_task_id, optional. When present: (1) the referenced task must belong to this project, (2) the referenced task must ITSELF have parent_task_id = null (one level of nesting only — a depth-2 attempt is rejected with HTTP 400), (3) phase_group_id is NOT required in the body — if omitted, the API inherits the PARENT's phase_group_id automatically (BUILD-SPEC.md "Sub-items inherit phase_group from parent"). An explicit phase_group_id in the body is still honoured if the caller passes one (e.g. a future UI that lets a sub-item live in a different group than its parent) — inheritance is only the DEFAULT when the field is omitted. */
export interface CreateSubTaskInputV3 {
  parent_task_id: string;
  title: string;
  description?: string | null;
  assignee_ids?: string[];
  contact_id?: string | null;
  due_date?: string | null;
  /** Overrides the parent's phase_group_id if explicitly supplied; inherited from the parent when omitted — see this interface's own doc comment. */
  phase_group_id?: string | null;
}

// ------------------------------------------------------------
// GET /api/projects/[id]/board response, Board-v3-flavoured — same
// shape as the Board cockpit round's BoardV2CockpitResponse
// (types/board-cockpit.ts) but with every task carrying `parent_task_id`
// (BoardTaskV3, above) instead of plain BoardTaskCockpit. Defined here
// (not by editing that file, a prior completed round's own file) for
// the same edit-boundary reason every other extension in this file
// follows — structurally these are simply BoardV2CockpitResponse with
// a richer `tasks` array on each column/group, so existing code reading
// only the Board-cockpit-round fields off a response typed this way
// keeps compiling unchanged.
// ------------------------------------------------------------

export interface BoardColumnV3 extends Omit<BoardColumnCockpit, "tasks"> {
  tasks: BoardTaskV3[];
}

export interface BoardGroupV3 extends Omit<BoardGroupCockpit, "tasks"> {
  tasks: BoardTaskV3[];
}

export interface BoardV3Response {
  columns: BoardColumnV3[];
  groups: BoardGroupV3[];
  team: AssigneeSummary[];
}

// ------------------------------------------------------------
// Apply stage template — POST /api/projects/[id]/board/apply-stage-template
// ------------------------------------------------------------

export interface ApplyStageTemplateResponse {
  filled_group_ids: string[];
  skipped_group_ids: string[];
  created_count: number;
}
