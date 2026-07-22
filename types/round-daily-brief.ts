// ============================================================
// RESLU Spec System — Daily Brief LOCAL types (Phillip, 8 July 2026,
// migration 041). BUILD-SPEC.md "Daily Brief".
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) or any prior round's own types/*.ts
// file — follows the exact same per-round-own-file convention every
// phase-N.ts / round-*.ts / board-v3*.ts file in this directory
// already uses. Every type below is scoped to this round's own files:
// supabase/migrations/041_brief_and_due_times.sql, lib/daily-brief.ts,
// lib/daily-brief-generate.ts, app/api/brief/**,
// components/my-work/DailyBrief.tsx, mcp/src/index.mjs.
// ============================================================

import type { DailyBriefSource } from "@/lib/daily-brief";

export type { DailyBriefSource };

export type DailyBriefStatus = "open" | "done";
export type DailyBriefCreatedByKind = "system" | "aria" | "user";

/** A daily_brief_items row, verbatim per migration 041's column list. */
export interface DailyBriefItem {
  id: string;
  brief_date: string;
  title: string;
  source: DailyBriefSource;
  link_href: string | null;
  status: DailyBriefStatus;
  acknowledged_at: string | null;
  created_by_kind: DailyBriefCreatedByKind;
  created_by: string | null;
  converted_task_id: string | null;
  /** See migration 041's own "SECOND DEVIATION NOTE" — the office-conversion sibling of converted_task_id (an office_tasks id can't be stored in a column FK'd to board_tasks). Mutually exclusive with converted_task_id. */
  converted_office_task_id: string | null;
  project_id: string | null;
  user_id: string | null;
  created_at: string;
}

/**
 * GET /api/brief's per-item projection — the row plus display-only
 * annotations computed at read time (never stored, see migration
 * 041's own "no note column" doc comment on daily_brief_items):
 *   - `project`: resolved project_id -> { id, name, alias }, same
 *     lightweight shape every other feed in this codebase attaches
 *     (MyWorkItem's own `project` field, types/phase-12a-b.ts).
 *   - `carried_over_label`: lib/daily-brief.ts's carriedOverLabel()
 *     output — null for an item whose brief_date IS today.
 *   - `converted_label`: set once converted_task_id is non-null —
 *     "added to {project name}" (board task) or "added to Office"
 *     (office task, project_id null on the brief row) — see
 *     app/api/brief/route.ts's own doc comment for exactly how this is
 *     derived at read time rather than stored.
 */
export interface DailyBriefItemWithMeta extends DailyBriefItem {
  project: { id: string; name: string; alias: string | null } | null;
  carried_over_label: string | null;
  converted_label: string | null;
}

/** GET /api/brief response — active open items only; completed rows stay stored but are hidden from My Work. */
export interface BriefResponse {
  items: DailyBriefItemWithMeta[];
  refreshed_at: string;
  done_count: number;
  total_count: number;
}

/** body accepted by POST /api/brief/items — manual (panel inline add) or Aria (add_brief_item MCP tool). */
export interface CreateBriefItemInput {
  title: string;
  /** Defaults to 'manual' when omitted (the panel's own inline-add form never sends this field at all) — 'aria' is set explicitly by the MCP tool / any Bearer-JWT-authenticated caller. No other source value is ever accepted here (booking/ordering/lead/trade are system-generated only, by the generator; email/invoice are reserved for a future pipeline). */
  source?: "manual" | "aria";
  link_href?: string | null;
  project_id?: string | null;
}

/** body accepted by PATCH /api/brief/items/[id] — tick/untick. */
export interface PatchBriefItemInput {
  status: DailyBriefStatus;
}

/** body accepted by POST /api/brief/items/[id]/convert. Omit project_id (or pass null) for "no project chosen" -> an Office task in the 'Phillip' group. */
export interface ConvertBriefItemInput {
  project_id?: string | null;
}

/** POST /api/brief/items/[id]/convert response. */
export interface ConvertBriefItemResponse {
  item: DailyBriefItemWithMeta;
  created: { kind: "board_task" | "office_task"; id: string };
}

/** POST/GET /api/brief/generate response — see lib/daily-brief-generate.ts's own doc comment for the full idempotency story. */
export interface GenerateBriefResponse {
  brief_date: string;
  created: number;
  by_source: Partial<Record<DailyBriefSource, number>>;
  email?: {
    sent: boolean;
    skipped?: string;
    item_count?: number;
  };
}

/** Minimal project-picker option for the "Add to project ->" popover — same lean shape as every other project picker in this codebase (e.g. components/estimate/ContactLinkPicker.tsx's own option shape). */
export interface BriefProjectOption {
  id: string;
  name: string;
  alias: string | null;
}
