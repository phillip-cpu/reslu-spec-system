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
// ============================================================

/** One row of the editable export_presets list (app_settings key 'export_presets'). */
export interface ExportPresetRow {
  name: string;
  /** Category prefixes this preset selects, e.g. ["TW", "SW"]. */
  prefixes: string[];
}

/** GET /api/settings/export-presets response. */
export interface ExportPresetsResponse {
  presets: ExportPresetRow[];
}

/** body accepted by PUT /api/settings/export-presets — full replace, admin-only (mirrors PUT /api/settings/phase-template's exact gating). */
export interface PutExportPresetsInput {
  presets: ExportPresetRow[];
}
