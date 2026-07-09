// ============================================================
// RESLU Spec System — Phase 13 LOCAL types
// Office board (global, not per-project) — see migration
// supabase/migrations/021_office.sql, docs/OFFICE-BRIEF.md,
// BUILD-SPEC.md §"13 Office".
//
// Kept out of types/index.ts per this codebase's established pattern
// (types/phase-12a-a.ts, types/phase-12a-b.ts) — a local, feature-
// scoped types file avoids touching the large shared file for a
// self-contained feature. Nothing in types/index.ts is read or
// modified by this file.
// ============================================================

import type { Profile } from "@/types";

/** Lightweight profile summary for an assignee chip — same shape as phase-12a-b's AssigneeSummary. */
export type OfficeAssigneeSummary = Pick<Profile, "id" | "full_name">;

/**
 * Team roster entry as returned by GET /api/office's `team` array —
 * OfficeAssigneeSummary plus `email`, so the `create_office_task` MCP
 * tool can resolve an `assignee_email` argument to a profile id without
 * a second route (this codebase has no GET /api/profiles listing
 * route — see that tool's doc comment in mcp/src/index.mjs). Board UI
 * code only ever needs id/full_name and simply ignores the extra
 * field.
 */
export type OfficeTeamMember = OfficeAssigneeSummary & { email: string };

export interface OfficeGroup {
  id: string;
  name: string;
  sort: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type OfficeTaskKind = "task" | "rule";

export interface OfficeSubtask {
  id: string;
  task_id: string;
  title: string;
  done: boolean;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface OfficeTask {
  id: string;
  group_id: string;
  title: string;
  description: string | null;
  kind: OfficeTaskKind;
  due_date: string | null;
  /** migration 041 ("Small pair" item 2, office parity) — optional wall-clock reminder time alongside due_date, "HH:MM:SS" or null. Never set for kind 'rule' (rule cards carry no due_date either). */
  due_time: string | null;
  sort: number;
  prev_group_id: string | null;
  created_by: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

/** An office_tasks row annotated with assignees + subtasks — the shape every Office board API response and the UI work with. */
export interface OfficeTaskWithRefs extends OfficeTask {
  assignees: OfficeAssigneeSummary[];
  subtasks: OfficeSubtask[];
}

export interface OfficeGroupWithTasks extends OfficeGroup {
  tasks: OfficeTaskWithRefs[];
}

/** GET /api/office response — the full board in one fetch. `team` carries `email` too (OfficeTeamMember) for the create_office_task MCP tool's assignee_email resolution; the board UI itself only reads id/full_name from it, same as OfficeAssigneeSummary. */
export interface OfficeBoardResponse {
  groups: OfficeGroupWithTasks[];
  team: OfficeTeamMember[];
}

/** body accepted by POST /api/office/tasks. */
export interface CreateOfficeTaskInput {
  group_id: string;
  title: string;
  description?: string | null;
  kind?: OfficeTaskKind;
  due_date?: string | null;
  /** migration 041 — see OfficeTask's own due_time doc comment. */
  due_time?: string | null;
  /** Omit to auto-assign the creator (mirrors Board v2's auto-assign-on-create); pass [] for none; pass profile ids to override. Ignored for kind 'rule' (rule cards carry no assignees). */
  assignee_ids?: string[];
}

/**
 * body accepted by PATCH /api/office/tasks/[id]. `complete`/`uncomplete`
 * are explicit boolean-intent actions (not a raw `completed_at` write)
 * so the archive-move side effect (group_id <-> prev_group_id swap) is
 * always applied consistently server-side — see that route's doc
 * comment for the full state transition.
 */
export interface PatchOfficeTaskInput {
  title?: string;
  description?: string | null;
  due_date?: string | null;
  /** migration 041 — see OfficeTask's own due_time doc comment. */
  due_time?: string | null;
  sort?: number;
  group_id?: string;
  assignee_ids?: string[];
  /** true = complete (and archive-move); false = uncomplete (and restore from prev_group_id). Omit to leave completion state untouched. */
  complete?: boolean;
}

/** body accepted by POST /api/office/subtasks. */
export interface CreateOfficeSubtaskInput {
  task_id: string;
  title: string;
}

/** body accepted by PATCH /api/office/subtasks/[id]. */
export interface PatchOfficeSubtaskInput {
  title?: string;
  done?: boolean;
  sort?: number;
}

/** body accepted by POST /api/office/groups. */
export interface CreateOfficeGroupInput {
  name: string;
}

/** body accepted by PATCH /api/office/groups/[id]. Archived is undeletable/unrenameable — enforced in the route, not here. */
export interface PatchOfficeGroupInput {
  name?: string;
  sort?: number;
}

/** The name of the standing Archived group — special-cased in the API (undeletable, unrenameable, collapsed by default in the UI) and the seed order in migration 021. */
export const OFFICE_ARCHIVED_GROUP_NAME = "Archived";

/** Seed order for brand-new office_groups rows — mirrors migration 021's insert exactly (kept here too so any future re-seed logic in the app layer, e.g. a "restore default groups" action, stays byte-identical to the migration's own list). */
export const OFFICE_DEFAULT_GROUPS = [
  "Marketing",
  "Website",
  "Meta Ads",
  "Google Ads",
  "Operations",
  "Systems & Tech",
  "Phillip",
  "Archived",
] as const;
