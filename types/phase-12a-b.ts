// ============================================================
// RESLU Spec System — Phase 12a-B LOCAL types
// My Work aggregator + personal notes, Board v2 (multi-assignee +
// phase grouping), housekeeping (alias/titleHref/view-portal link —
// mostly prop additions, no new shared types needed), client events +
// reminders.
//
// Deliberately NOT added to types/index.ts: another agent worked
// concurrently in this same working copy on Phase 12a-A (estimate
// versioning, SOW templates, plan analysis/takeoff) and left their own
// types/phase-12a-a.ts for exactly this reason (see that file's own
// header comment) — types/index.ts is a shared file both agents would
// otherwise collide on. This file follows the identical pattern: every
// type below is scoped to this feature's own files
// (components/board/**, app/api/my-work/**, app/api/client-events/**,
// lib/client-event-reminders.ts) and imported from here instead of
// types/index.ts. If a human later consolidates both phase-12a-*.ts
// files into types/index.ts, this file's shapes already mirror that
// file's own conventions (mirrors DB schema / API request-response
// shapes) so the merge is mechanical.
//
// Cross-imports from types/index.ts are READ-ONLY reuse of existing,
// already-defined shapes — nothing in types/index.ts is modified.
// ============================================================

import type { BoardColumn, BoardTask, ContactSummary, Profile, Project, ProjectWithCounts } from "@/types";

// ------------------------------------------------------------
// Housekeeping — projects.alias (migration 020)
// BUILD-SPEC.md §"Housekeeping — 5 July screenshot" point 2: "projects
// gains alias text ... displayed as a muted suffix/subtitle on
// internal surfaces (dashboard card, project header, My Work). NEVER
// client-facing (portal/PDF keep formal name)." types/index.ts's
// `Project`/`ProjectWithCounts` interfaces are NOT extended with this
// column directly (that shared file is out of this feature's edit
// boundary, per the same concurrent-agent isolation this file's own
// header comment explains) — every call site that needs to read/write
// `alias` uses one of these intersection types instead.
// ------------------------------------------------------------

// job_number (migration 028_job_numbers.sql, "Three from Phillip — 6
// July 2026 evening" item 2) is added here for the same reason as
// alias above — types/index.ts is out of this task's edit boundary —
// and reuses the exact same intersection-type pattern rather than
// introducing a third parallel convention.
export type ProjectWithAlias = Project & { alias: string | null; job_number: string | null };
export type ProjectWithCountsAndAlias = ProjectWithCounts & { alias: string | null; job_number: string | null };

// ------------------------------------------------------------
// Board v2 — multi-assignee
// ------------------------------------------------------------

/** Lightweight profile summary for an assignee chip — same shape as the existing single-assignee `{ id, full_name }` projection this codebase already uses (GET /api/projects/[id]/board), just now an array. */
export type AssigneeSummary = Pick<Profile, "id" | "full_name">;

/**
 * A board_tasks row annotated with MULTI-assignee display data
 * (board_task_assignees join, migration 020) plus the existing
 * contact/phase-group refs. Supersedes types/index.ts's
 * `BoardTaskWithRefs` (which carried a single `assignee`) for every
 * Board v2 call site — the old single-`assignee` shape is left
 * untouched in types/index.ts since it's out of this feature's file
 * boundary, but nothing in this feature's own files (the rewritten
 * ProjectBoard.tsx, the board API routes) uses it any more.
 */
export interface BoardTaskWithAssignees extends BoardTask {
  assignees: AssigneeSummary[];
  contact: ContactSummary | null;
  phase_group_id: string | null;
}

export interface BoardGroup {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
  /**
   * Fix Round A phase unification (migration 023) — nullable FK to
   * schedule_phases. See app/api/projects/[id]/phases/route.ts's GET
   * doc comment for THE INVARIANT in full: schedule_phases.name is the
   * single source of truth for a unified phase's label; this column's
   * sibling `name` above is kept as a synced mirror. Added directly to
   * the base BoardGroup (rather than a separate BoardGroupWithPhase
   * type) since every caller of this shape needs to know whether a
   * group is unified with a phase — it is not an optional annotation
   * layered on top the way `tasks` is in BoardGroupWithTasks below.
   */
  phase_id: string | null;
}

/** A board_groups row with its (non-deleted) tasks nested — Grouped list view. */
export interface BoardGroupWithTasks extends BoardGroup {
  tasks: BoardTaskWithAssignees[];
  /**
   * Round A "Board owns dates, Timeline is the visual" — the linked
   * schedule_phases row's own start_date/end_date (GET
   * /api/projects/[id]/board merges these in via a lightweight second
   * query keyed by every group's phase_id, see that route's doc
   * comment). Both null when phase_id is null (unlinked/legacy group —
   * the Grouped-list header renders no date inputs for these, per this
   * round's brief) — never independently editable state on
   * board_groups itself; PATCHing them goes through the EXISTING PATCH
   * /api/phases/[id] route, same single source of truth THE INVARIANT
   * already established for `name` (see that route's own doc comment).
   */
  phase_start_date: string | null;
  phase_end_date: string | null;
}

export interface BoardColumnWithAssigneeTasks extends BoardColumn {
  tasks: BoardTaskWithAssignees[];
}

/** GET /api/projects/[id]/board response (Board v2 shape — columns AND groups, since a card belongs to both a status column and, optionally, a phase group). */
export interface BoardV2Response {
  columns: BoardColumnWithAssigneeTasks[];
  groups: BoardGroupWithTasks[];
  /** Every non-deleted task for the project, flat — the single source the UI slices into columns (kanban view) or groups (grouped-list view) without two separate fetches. */
  team: AssigneeSummary[];
}

/** body accepted by POST /api/projects/[id]/board (creates a task) — Board v2 adds assignee_ids[] (defaults to [creator] — auto-assign — unless explicitly overridden with an empty array) and phase_group_id. */
export interface CreateBoardTaskInputV2 {
  column_id: string;
  title: string;
  description?: string | null;
  /** Omit to auto-assign the creator (BUILD-SPEC.md "auto-assign on create ... overridable"); pass [] explicitly for "no assignees"; pass one or more profile ids to override. */
  assignee_ids?: string[];
  contact_id?: string | null;
  due_date?: string | null;
  phase_group_id?: string | null;
}

/** body accepted by PATCH /api/board-tasks/[id] — Board v2 adds assignee_ids[] (full replace of the task's assignee set) and phase_group_id. */
export interface PatchBoardTaskInputV2 {
  column_id?: string;
  title?: string;
  description?: string | null;
  assignee_ids?: string[];
  contact_id?: string | null;
  due_date?: string | null;
  sort?: number;
  phase_group_id?: string | null;
}

/** body accepted by POST /api/projects/[id]/board/groups. */
export interface CreateBoardGroupInput {
  name: string;
}

/** body accepted by PATCH /api/board-groups/[id]. */
export interface PatchBoardGroupInput {
  name?: string;
  sort?: number;
}

// REMOVED (Fix Round A / migration 023): this file used to export a
// DEFAULT_PHASE_GROUPS = ["Site Prep", "Demolition", "Rough-in",
// "Waterproofing & Tiling", "Fit-off", "Handover"] constant here
// (BUILD-SPEC.md "Board v2" point 3). It is superseded by the
// editable app_settings('phase_template') row (migration 023), seeded
// via lib/phase-seed.ts's seedPhaseTemplateIfEmpty() and consumed by
// BOTH the Timeline tab and the Board's Grouped-list view (the "shared
// seed path" — BUILD-SPEC.md "Pre-populated phases"), not just
// board_groups — see lib/phase-template.ts's FALLBACK_PHASE_TEMPLATE
// for the current single source of truth (which additionally carries
// each row's `kind`, umbrella vs phase, this flat string array never
// had). Deleted outright rather than left as an unused export, since
// an unused exported constant is a worse trap for a future reader than
// a comment pointing at its replacement.

/** The Board v2 column reorder — BUILD-SPEC.md "Board v2" point 2: "'Waiting' becomes the FIRST default column (Waiting -> To Do -> In Progress -> Done) for new boards." Existing boards are NOT touched by this reorder (see this feature's board route doc comment for the "untouched" heuristic). */
export const DEFAULT_COLUMNS_V2 = ["Waiting", "To Do", "In Progress", "Done"] as const;

// ------------------------------------------------------------
// My Work aggregator
// ------------------------------------------------------------

export type MyWorkBucket = "overdue" | "today" | "this_week" | "no_date";

export type MyWorkItemKind =
  | "board_task"
  | "lead_follow_up"
  | "diary_draft"
  | "trade_proposal"
  | "decision_overdue"
  // Phase 13 — Office board task assigned to me (office_tasks via
  // office_task_assignees). See app/api/my-work/route.ts source #6 and
  // types/phase-13.ts's OfficeTask. Kept as a MyWorkItemKind here
  // (rather than in phase-13.ts) since MyWorkItem/MyWorkItemKind are
  // this file's own shared aggregator shapes every source kind slots
  // into — additive, surgical edit per this task's boundary.
  | "office_task"
  // Fix Round A — a contact with insurance_required = true (migration
  // 026, Quick items round 6 July 2026) whose computed insurance_status
  // is 'expiring' or 'expired'. See app/api/my-work/route.ts source #7.
  // Same additive pattern as office_task above — this file's own
  // established convention for slotting a new source into the shared
  // aggregator.
  | "insurance_expiring"
  // Phase 12b — design_tasks assigned to me with a due date, via
  // design_task_assignees. See app/api/my-work/route.ts source #8 and
  // types/phase-12b.ts's DesignTask. Same additive pattern as
  // office_task/insurance_expiring above — this task's brief calls for
  // "design_tasks assigned to me with due dates join the aggregator
  // with a 'Design' context chip" (rendered via this kind's `meta`
  // field, set to "Design" in the source query below).
  | "design_task";

/**
 * One row in the My Work feed, normalised across five very different
 * source tables (board_tasks, leads, portal_updates, trade_visits,
 * items) into a single shape the page can group/render uniformly.
 * `due` drives bucketing (see lib/my-work.ts bucketFor()); kinds with
 * no natural "due date" concept (diary drafts, trade proposals) use
 * the date that made them actionable (submitted_at / proposed at) as
 * a stand-in so they still land in a sensible bucket rather than
 * always falling into `no_date`.
 */
export interface MyWorkItem {
  kind: MyWorkItemKind;
  id: string;
  title: string;
  /** Project context chip — null only for leads (pre-project) and is itself then rendered as a distinct "Lead" chip instead of a project name. */
  project: { id: string; name: string; alias: string | null } | null;
  due: string | null; // ISO date or timestamp
  /** Deep link — project sub-tab, /leads, or the client area, per kind. */
  href: string;
  /** Short secondary label shown muted under the title, e.g. a column name, a lead stage, a trade company. */
  meta: string | null;
}

export interface MyWorkGroups {
  overdue: MyWorkItem[];
  today: MyWorkItem[];
  this_week: MyWorkItem[];
  no_date: MyWorkItem[];
}

/** GET /api/my-work response. */
export interface MyWorkResponse {
  groups: MyWorkGroups;
  is_admin: boolean;
}

// ------------------------------------------------------------
// Personal notes (user_notes)
// ------------------------------------------------------------

export interface UserNote {
  id: string;
  user_id: string;
  text: string;
  done: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

/** body accepted by POST /api/my-work/notes. */
export interface CreateUserNoteInput {
  text: string;
}

/** body accepted by PATCH /api/my-work/notes/[id]. */
export interface PatchUserNoteInput {
  text?: string;
  done?: boolean;
  sort?: number;
}

export interface UserNotesResponse {
  notes: UserNote[];
}

// ------------------------------------------------------------
// Client events (portal "Upcoming meetings")
// ------------------------------------------------------------

export interface ClientEvent {
  id: string;
  project_id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
  reminder_sent_at: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** body accepted by POST /api/projects/[id]/client-events. */
export interface CreateClientEventInput {
  title: string;
  starts_at: string;
  ends_at?: string | null;
  location?: string | null;
  notes?: string | null;
}

/** body accepted by PATCH /api/client-events/[id]. */
export interface PatchClientEventInput {
  title?: string;
  starts_at?: string;
  ends_at?: string | null;
  location?: string | null;
  notes?: string | null;
}

export interface ClientEventsResponse {
  events: ClientEvent[];
}

/** Portal-facing projection — future events only, no internal notes field beyond what's client-appropriate (see lib/client-event-reminders.ts doc comment: notes on THIS table are authored client-facing by design, unlike trade_visits.notes which is internal-only). */
export interface PortalClientEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
}
