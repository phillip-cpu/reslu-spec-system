// ============================================================
// RESLU Spec System — Phase 12a-A LOCAL types
// Estimate versioning + VM comparison, SOW clause templates, Aria plan
// analysis + takeoff assist.
//
// Deliberately NOT added to types/index.ts: another agent is working
// concurrently in the same working copy on Phase 12a-B (My Work, Board
// v2, housekeeping) and that shared file is an explicit no-touch
// boundary for this build to avoid collisions between the two
// concurrent agents. Every type below is scoped to this feature's own
// files (lib/estimate-versions.ts, lib/sow-templates.ts, lib/takeoff.ts,
// the app/api/projects/[id]/versions/**, app/api/versions/[id]/**,
// app/api/projects/[id]/plan-analysis/** routes, and
// components/estimate/VersionsPanel.tsx + VersionCompare.tsx +
// components/projects/PlanCheckCard.tsx) and imported from here
// instead of types/index.ts.
//
// Mirrors types/index.ts's own conventions (mirrors DB schema / API
// request-response shapes) as closely as possible so a future
// consolidation pass (if the two agents' work is merged by a human) is
// a mechanical cut-and-paste, not a redesign.
// ============================================================

// The only cross-import from the shared types/index.ts is READ-ONLY
// reuse of existing, already-defined shapes (CostLine,
// CostSectionWithLines, FfeRollup) — nothing in types/index.ts itself
// is modified or extended by this feature.
import type {
  CostLine,
  CostSectionWithLines,
  FfeRollup,
  Measurement,
  MeasurementWithGroup,
  ProjectFile,
  SowSectionWithLines,
} from "@/types";

export type { CostLine, CostSectionWithLines, FfeRollup };

/**
 * Migration 019_versions_sow_analysis.sql adds `status`/`source`/
 * `provenance_note` to the `measurements` table (BUILD-SPEC.md "Aria
 * takeoff assist"). Rather than duplicate the whole Measurement shape
 * here, this feature's own files use `Measurement & MeasurementTakeoffFields`
 * wherever a row needs the new columns — an intersection stays in sync
 * with types/index.ts's Measurement automatically if that shared
 * interface's other fields ever change, since nothing here re-lists
 * them.
 */
export interface MeasurementTakeoffFields {
  status: MeasurementStatus;
  source: MeasurementSource;
  provenance_note: string | null;
}

export type MeasurementStatus = "draft" | "verified";
export type MeasurementSource = "manual" | "takeoff";

/** A measurement row including this feature's additive takeoff columns. */
export type MeasurementWithTakeoffFields = Measurement & MeasurementTakeoffFields;

/** A measurement-with-group row including this feature's additive takeoff columns. */
export type MeasurementWithGroupAndTakeoffFields = MeasurementWithGroup & MeasurementTakeoffFields;

/** body accepted by PATCH /api/estimate/measurements/[id] — the ONE field this feature adds to that route's existing partial-update body. */
export interface PatchMeasurementStatusInput {
  status?: MeasurementStatus;
}

// ------------------------------------------------------------
// Estimate versioning + VM comparison
// ------------------------------------------------------------

export type EstimateVersionKind = "issue" | "vm";

/**
 * Full frozen estimate snapshot stored in estimate_versions.snapshot —
 * everything the read-only viewer and VM comparison view need to
 * render a past estimate state without touching any live table.
 * Mirrors types/index.ts's EstimateResponse shape (a superset, plus
 * the linked SOW revision label) without importing that exact type
 * (EstimateResponse itself isn't exported in a form this module needs
 * verbatim — this is a deliberate local mirror, not a re-export).
 */
export interface EstimateSnapshot {
  sections: CostSectionWithLines[];
  markup_pct: number;
  rollup: {
    allTradesSubtotalExGst: number;
    approvedVariationsExGst: number;
    markupPct: number;
    markupExGst: number;
    totalToClientExGst: number;
    gst: number;
    totalIncGst: number;
    quotedExGst: number;
    actualExGst: number;
  };
  ffe: FfeRollup;
  wholeJob: {
    trades: EstimateSnapshot["rollup"];
    ffe: FfeRollup;
    combinedExGst: number;
    combinedGst: number;
    combinedIncGst: number;
  };
  measurements: MeasurementWithGroup[];
  /** The SOW revision label current at the moment this version was saved, if any. */
  sow_revision_label: string | null;
}

export interface EstimateVersion {
  id: string;
  project_id: string;
  label: string;
  kind: EstimateVersionKind;
  snapshot: EstimateSnapshot;
  note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** List rows omit the (potentially large) snapshot payload — see GET /api/projects/[id]/versions. */
export type EstimateVersionSummary = Omit<EstimateVersion, "snapshot">;

export interface EstimateVersionsListResponse {
  versions: EstimateVersionSummary[];
}

export interface EstimateVersionResponse {
  version: EstimateVersion;
}

/** body accepted by POST /api/projects/[id]/versions — freezes the CURRENT live estimate state into a new version. */
export interface CreateEstimateVersionInput {
  label: string;
  kind?: EstimateVersionKind;
  note?: string | null;
}

/** One line's fate in a section-level diff — see lib/estimate-versions.ts diffSections(). */
export type LineDiffStatus = "added" | "removed" | "changed" | "unchanged";

export interface LineDiffEntry {
  status: LineDiffStatus;
  /** The line as it appears in side B (current/other version) — null when status is 'removed'. */
  line: CostLine | null;
  /** The line as it appeared in side A (the base version) — null when status is 'added'. */
  previous: CostLine | null;
  /** lineCost(line B) - lineCost(line A) — ex GST, null if either side's cost can't be computed. */
  costDelta: number | null;
}

export interface SectionDiffEntry {
  name: string;
  lines: LineDiffEntry[];
  /** Sum of costDelta across this section's lines (nulls treated as 0). */
  sectionDelta: number;
}

/** FF&E item substitution matched by item_code — "was X -> now Y, saving $Z". */
export interface FfeSubstitution {
  item_code: string;
  was: { name: string; total: number } | null;
  now: { name: string; total: number } | null;
  /** was.total - now.total, ex GST. Positive = a saving. */
  saving: number;
}

/** GET /api/projects/[id]/versions/compare response. */
export interface VersionCompareResponse {
  a: { label: string; created_at: string | null };
  b: { label: string; created_at: string | null };
  sections: SectionDiffEntry[];
  ffeSubstitutions: FfeSubstitution[];
  totalSavingExGst: number;
  totalA: number;
  totalB: number;
}

// ------------------------------------------------------------
// SOW clause templates (lib/sow-templates.ts)
// ------------------------------------------------------------

/** Local mirror of types/index.ts's SowLineKind literal union. */
export type LocalSowLineKind = "inclusion" | "exclusion" | "note";

export interface SowTemplateLine {
  text: string;
  kind: LocalSowLineKind;
}

export interface SowTemplateSection {
  heading: string;
  lines: SowTemplateLine[];
}

/** body accepted by POST /api/projects/[id]/sow/[sowId]/from-template. */
export interface ApplyTemplateInput {
  groups?: string[];
  include_rooms?: boolean;
}

/** response shape for POST /api/projects/[id]/sow/[sowId]/from-template. */
export interface ApplyTemplateResponse {
  sections: SowSectionWithLines[];
}

// ------------------------------------------------------------
// Aria plan analysis + takeoff assist
// ------------------------------------------------------------

export interface PlanAnalysisRoomDimensions {
  room_name: string;
  length_m?: number | null;
  width_m?: number | null;
  height_m?: number | null;
  opening_count?: number | null;
  wet_area?: boolean;
}

/** body accepted by POST /api/projects/[id]/plan-analysis — Aria's extraction results. */
export interface SubmitPlanAnalysisInput {
  file_id: string;
  revision_label?: string | null;
  rooms: string[];
  item_codes: string[];
  dimensions?: PlanAnalysisRoomDimensions[];
  analysed_by?: string | null;
}

export type PlanDiscrepancyKind =
  | "code_missing_from_register"
  | "register_item_not_on_plan"
  | "room_with_no_ffe_items"
  | "location_name_mismatch";

export interface PlanDiscrepancy {
  kind: PlanDiscrepancyKind;
  message: string;
  item_codes?: string[];
  room_names?: string[];
}

export interface PlanAnalysis {
  id: string;
  project_id: string;
  file_id: string;
  revision_label: string | null;
  rooms: string[];
  item_codes: string[];
  dimensions: PlanAnalysisRoomDimensions[];
  discrepancies: PlanDiscrepancy[];
  analysed_at: string;
  analysed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface PendingPlanAnalysisResponse {
  files: (ProjectFile & { url: string | null })[];
}

export interface SubmitPlanAnalysisResponse {
  analysis: PlanAnalysis;
  measurements_drafted: MeasurementWithTakeoffFields[];
}

export interface PlanAnalysisSummaryResponse {
  latest: PlanAnalysis | null;
}
