// ============================================================
// RESLU Spec System — Round D LOCAL types (7 July 2026, migration 030
// round — "standard spec items + lead notes").
// BUILD-SPEC.md "Two from Phillip — 7 July 2026 (migration 030
// round)".
//
// Same isolation convention every phase-N.ts / round-*.ts file in this
// directory already follows (see types/round-b.ts's own header comment
// for the fullest statement of the rationale): types/index.ts is a
// protected file for this round (per the task brief's DO-NOT-TOUCH
// list), so any shape needed only by this round's own files lives
// here instead and is imported directly from this module rather than
// added to the shared file.
// ============================================================

import type { Lead, LibraryItem } from "@/types";

// ------------------------------------------------------------
// Standard spec items — library_items.is_standard (migration 030).
// ------------------------------------------------------------

/**
 * The one new library_items column from migration 030, as a
 * standalone patchable shape (LibraryItem itself is defined in the
 * protected types/index.ts and is NOT extended here — API routes merge
 * this field onto the existing LibraryItem response object at runtime
 * instead of this type literally extending LibraryItem, same pattern
 * types/round-b.ts's ItemQuantityLinkFields already uses for items).
 */
export interface StandardFlagFields {
  is_standard: boolean;
}

/** A LibraryItem as returned by every existing GET/POST/PATCH library
 * route once this round's column is selected — plain LibraryItem plus
 * is_standard, which is present on every row via `select("*")`/the
 * existing column list (this column is genuinely on the table now;
 * this type just documents that at the TS level without touching the
 * protected LibraryItem interface itself). */
export type LibraryItemWithStandardFlag = LibraryItem & StandardFlagFields;

/** Body accepted by PATCH /api/library/[id] for the new field — same
 * route, just one more whitelisted key. */
export interface PatchStandardFlagInput {
  is_standard?: boolean;
}

/**
 * Body field accepted by both project-creation paths (POST
 * /api/projects and POST /api/leads/[id]/create-project) — the
 * selected standard-spec library item ids to copy onto the new
 * project's spec register, via the SAME shared copy helper
 * (lib/library-items.ts copyLibraryItemToProject()) the existing
 * library→project "add to register" path already uses. Both routes'
 * body types are widened with this via an intersection at the call
 * site rather than editing CreateProjectInput in the protected
 * types/index.ts.
 */
export interface StandardItemIdsInput {
  standard_item_ids?: string[];
}

// ------------------------------------------------------------
// Lead notes — lead_notes table (migration 030). Deliberate
// structural mirror of types/index.ts's own ItemNote interface (see
// that file / item_notes table in 001_initial.sql) — same four
// content fields, same shape, just against a lead instead of an item.
// ------------------------------------------------------------

export interface LeadNote {
  id: string;
  lead_id: string;
  author_id: string | null;
  author_name: string;
  text: string;
  created_at: string;
}

/** GET /api/leads/[id]/notes response — newest first (matches the
 * route's actual `created_at` descending order and docs/API.md). */
export interface LeadNotesListResponse {
  notes: LeadNote[];
}

/** body accepted by POST /api/leads/[id]/notes — mirrors POST
 * /api/items/[id]/notes exactly: `{ text }`, author_name denormalised
 * server-side from the caller's profile. */
export interface CreateLeadNoteInput {
  text: string;
}

/** response shape for POST /api/leads/[id]/notes. */
export interface LeadNoteResponse {
  note: LeadNote;
}

/** A Lead as it exists once this round ships — plain Lead, unchanged
 * (leads.notes itself is not dropped, just no longer offered for
 * direct editing in the UI — see components/leads/LeadDetailPanel.tsx
 * and this migration's own header comment). Exported here only so
 * call sites that want to reference "a Lead, now with its notes feed
 * migrated" have a single documented anchor; it does not add any
 * field beyond the existing Lead. */
export type LeadWithNotesFeed = Lead;
