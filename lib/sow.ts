// ============================================================
// RESLU Spec System — Scope of Works builder + document traffic
// lights, shared pure helpers.
// BUILD-SPEC.md "Scope of Works builder", "Project overview hub".
// Used by both the API routes (app/api/projects/[id]/sow/**,
// app/api/projects/[id]/document-status/**) and the UI
// (components/sow/**), so seed structure and status defaults can
// never drift between server and client. Deliberately
// dependency-free (no Supabase/Next imports here), same convention as
// lib/estimate.ts.
// ============================================================

import type { DocumentStatus, ProjectFileKind } from "@/types";

// ------------------------------------------------------------
// SOW seed structure
// BUILD-SPEC.md "Scope of Works builder": "structured data (sections
// → line items, room-by-room, inclusions/exclusions per the RESLU
// .dotx template structure)". A new SOW starts with:
//   General / Preliminaries
//   <one section per room, from the project's distinct item
//     locations when it has any, else a sane fallback room list>
//   Exclusions
//   Assumptions
// ------------------------------------------------------------

/** First section for every new SOW, before any room sections. */
export const SOW_LEAD_SECTION = "General / Preliminaries";

/** Trailing sections for every new SOW, after all room sections. */
export const SOW_TRAILING_SECTIONS = ["Exclusions", "Assumptions"];

/** Fallback room list when the project has no items with a location set yet. */
export const SOW_FALLBACK_ROOMS = ["Kitchen", "Main Bathroom", "Ensuite", "Laundry"];

/**
 * Builds the seed section heading list for a brand-new SOW.
 *
 * `itemLocations` — the project's distinct, non-empty item.location
 * values, in whatever order the caller fetched them (the API route
 * sorts them alphabetically before calling this, for a predictable
 * section order — see app/api/projects/[id]/sow/route.ts). When empty,
 * SOW_FALLBACK_ROOMS is used instead so a brand-new project (no items
 * specced yet) still gets a sensible starting structure the team can
 * rename/add to rather than an empty room list.
 */
export function seedSowSections(itemLocations: string[]): string[] {
  const rooms = itemLocations.length > 0 ? itemLocations : SOW_FALLBACK_ROOMS;
  return [SOW_LEAD_SECTION, ...rooms, ...SOW_TRAILING_SECTIONS];
}

/**
 * Next revision label after `current` — "T1" -> "T2" -> "T3" etc.
 * Falls back to "T1" if the current label doesn't match the T-number
 * convention (e.g. was hand-edited to something unexpected), so
 * "New revision" never throws even on unusual data.
 */
export function nextRevisionLabel(current: string): string {
  const match = /^T(\d+)$/i.exec(current.trim());
  if (!match) return "T1";
  return `T${Number(match[1]) + 1}`;
}

// ------------------------------------------------------------
// Document traffic lights
// BUILD-SPEC.md "Project overview hub": "Red should be the default
// for non-N/A kinds on active projects so gaps are loud." — plans,
// council, engineering, scope_of_works default to 'not_started'
// (red) when unset; 'other' defaults to 'na' (grey) since it's a
// catch-all bucket, not a tracked deliverable.
// ------------------------------------------------------------

/** Kinds tracked on the Documents overview card / traffic lights (excludes the 'other' catch-all). */
export const TRACKED_DOCUMENT_KINDS: ProjectFileKind[] = [
  "plans",
  "council",
  "engineering",
  "scope_of_works",
];

const DEFAULT_STATUS_BY_KIND: Record<ProjectFileKind, DocumentStatus> = {
  plans: "not_started",
  council: "not_started",
  engineering: "not_started",
  scope_of_works: "not_started",
  other: "na",
};

/**
 * Resolves the effective status for a document kind: whatever is
 * stored in projects.document_status[kind], or the kind's default
 * (red/not_started for the four tracked kinds, grey/na for 'other')
 * when that key is absent. Archived/completed projects still use the
 * same defaults here — the "make gaps loud" behaviour is deliberately
 * unconditional on project status per the build spec's wording
 * ("active projects" describes the common case the rule is aimed at,
 * not a status the API special-cases).
 */
export function documentStatusFor(
  documentStatus: Partial<Record<ProjectFileKind, DocumentStatus>> | null | undefined,
  kind: ProjectFileKind
): DocumentStatus {
  return documentStatus?.[kind] ?? DEFAULT_STATUS_BY_KIND[kind];
}

/** Cycle order for the click-to-advance traffic light: na -> not_started -> draft -> done -> na. */
const CYCLE_ORDER: DocumentStatus[] = ["na", "not_started", "draft", "done"];

export function nextDocumentStatus(current: DocumentStatus): DocumentStatus {
  const idx = CYCLE_ORDER.indexOf(current);
  return CYCLE_ORDER[(idx + 1) % CYCLE_ORDER.length];
}

export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  na: "N/A",
  not_started: "Not started",
  draft: "Draft",
  done: "Done",
};

/** Accessible-tone colours per BUILD-SPEC.md's palette guidance — always paired with the text label, never colour alone. */
export const DOCUMENT_STATUS_COLOUR: Record<DocumentStatus, string> = {
  na: "#8A8578", // muted sand-grey
  not_started: "#A32D2D",
  draft: "#BA7517",
  done: "#3B6D11",
};

export function isValidDocumentStatus(value: unknown): value is DocumentStatus {
  return value === "na" || value === "not_started" || value === "draft" || value === "done";
}

// ------------------------------------------------------------
// Phase 12a-A additive — room-section seeding from the CURRENT rooms
// schema (migration 015_rooms.sql). seedSowSections() above still
// drives POST /api/projects/[id]/sow (a project's very first T1
// revision) unchanged, reading from items.location — that free-text
// legacy layer is left exactly as it was, per this feature's
// instruction to not touch existing behaviour there.
//
// "Start from template" (POST /api/projects/[id]/sow/[sowId]/from-template,
// Phase 12a-A) is new call path that seeds room sections from the
// `rooms` table instead — the richer, current per-project room model —
// since BUILD-SPEC.md's SOW completion brief explicitly calls for "one
// section per project room" sourced from the CURRENT schema, not the
// older item-location convention. Falls back to SOW_FALLBACK_ROOMS
// when a project has no rooms defined yet, same spirit as
// seedSowSections()'s own fallback.
// ------------------------------------------------------------

/** Section heading list sourced from a project's `rooms` table (name, sorted), for the template "Start from template" action. */
export function roomSectionHeadings(roomNames: string[]): string[] {
  return roomNames.length > 0 ? roomNames : SOW_FALLBACK_ROOMS;
}
