// ============================================================
// RESLU Spec System — "Export + board batch" round LOCAL types
// (Phillip, 7 July 2026).
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's file-boundary list) — follows the same per-round-own-file
// convention every phase-N.ts / round-*.ts file in this directory
// already uses (see types/phase-fix-a.ts's header comment for the
// fullest statement of the rationale). Everything below is scoped to
// this round's own files: app/api/settings/export-presets/**,
// components/settings/ExportPresetSettings.tsx,
// components/projects/ExportDialog.tsx,
// app/api/projects/[id]/pdf/route.ts, lib/pdf-bundle.ts,
// components/pdf/DocSeparatorPdf.tsx.
//
// "Trade booking document pack" round (8 July 2026) addition:
// `contact_categories` on ExportPresetRow — see that field's own doc
// comment below. Edited in place (not a separate intersection type in
// types/trade-doc-pack.ts) because ExportPresetRow is this file's own
// shape and this round already owns app_settings('export_presets') as
// a read/write dependency (lib/export-presets.ts, the settings editor,
// BookVisitPanel's auto-pick) — the same "extend the owning round's
// own file" reasoning types/board-v3-3.ts's header comment uses for
// why it does NOT copy PatchBoardTaskInputV2 wholesale. No existing
// caller of ExportPresetRow breaks: the field is optional, and every
// pre-existing preset row (seeded before this round, or written by an
// older client that never sends it) simply omits it, which every call
// site below treats identically to an explicit empty array.
// ============================================================

/** One row of the editable export_presets list (app_settings key 'export_presets'). */
export interface ExportPresetRow {
  name: string;
  /** Category prefixes this preset selects, e.g. ["TW", "SW"]. */
  prefixes: string[];
  /**
   * "Trade booking document pack" — optional contact categories this
   * preset is understood to apply to, e.g. ["Plumber", "Plumbing"].
   * Free text, matched case-insensitively with CONTAINMENT (not exact
   * equality) against a booking contact's own `contacts.category`
   * value in both directions — see lib/export-presets.ts's
   * pickPresetForContactCategory() for the exact algorithm. Optional/
   * omittable: a preset with no contact_categories (or an empty array)
   * simply never wins an auto-pick match on category and falls through
   * to the name-heuristic / full-schedule default, same as any preset
   * seeded before this round existed.
   */
  contact_categories?: string[];
}

/** GET /api/settings/export-presets response. */
export interface ExportPresetsResponse {
  presets: ExportPresetRow[];
}

/** body accepted by PUT /api/settings/export-presets — full replace, admin-only (mirrors PUT /api/settings/phase-template's exact gating). */
export interface PutExportPresetsInput {
  presets: ExportPresetRow[];
}

// ------------------------------------------------------------
// NOTE: the full DocumentPackChoices / trade-page-DOCUMENTS-section /
// tokened-proxy shapes for the "Trade booking document pack" round
// live in their OWN file, types/trade-doc-pack.ts — not here — since
// that round's file-boundary list (app/trade/[token]/**,
// app/api/trade/[token]/documents/**, components/board/
// BookVisitPanel.tsx, components/trade/**, lib/trade-doc-pack.ts) is
// materially larger than "just the export-presets extension" above.
// Only the ExportPresetRow.contact_categories field itself lives in
// this file, per this file's own updated header comment.
// ------------------------------------------------------------
