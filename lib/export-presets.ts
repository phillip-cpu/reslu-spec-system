// ============================================================
// RESLU Spec System — "Export + board batch" round (Phillip, 7 July
// 2026) — trade export presets. Pure, dependency-free domain logic —
// no Supabase/Next imports — mirroring lib/phase-template.ts's exact
// shape (a code-level FALLBACK constant kept byte-for-byte in sync
// with app_settings's seeded default, plus small pure helpers reused
// by both the API route and the export dialog).
// ============================================================

import type { ExportPresetRow } from "@/types/round-export-batch";

/**
 * Code-fallback seed (BUILD-SPEC.md "Export + board batch" item 1):
 * "Plumber → TW+SW; Electrician → LI+EL". Used whenever
 * app_settings('export_presets') is missing/empty — this is NOT a
 * migration seed (no new migration in this round — app_settings
 * carries presets with no schema change needed), so a fresh
 * environment that has never had this key written falls back to this
 * list rather than showing an empty presets bar.
 */
export const FALLBACK_EXPORT_PRESETS: ExportPresetRow[] = [
  { name: "Plumber", prefixes: ["TW", "SW"] },
  { name: "Electrician", prefixes: ["LI", "EL"] },
];

/** Trims/validates one preset row — shared by the PUT route's validation and the settings editor's optimistic-add path. */
export function cleanPresetRow(row: {
  name?: unknown;
  prefixes?: unknown;
}): ExportPresetRow | null {
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  if (!Array.isArray(row?.prefixes)) return null;
  const prefixes = row.prefixes
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().toUpperCase());
  if (prefixes.length === 0) return null;
  return { name, prefixes: [...new Set(prefixes)] };
}

/**
 * Builds the ?categories= query value for a given set of selected
 * category prefixes — comma-joined, matching the PDF route's
 * multi-category filter (extended from the old single-`?category=`
 * param — see app/api/projects/[id]/pdf/route.ts).
 */
export function categoriesQueryValue(prefixes: string[]): string {
  return [...new Set(prefixes.map((p) => p.trim().toUpperCase()).filter(Boolean))].join(",");
}

/** Parses a `categories=TW,SW` (or legacy singular `category=TW`) query value back into a de-duped, upper-cased prefix array. Empty/absent means "no filter — every category" per the dialog's "all ticked default = full schedule" behaviour. */
export function parseCategoriesParam(value: string | null): string[] {
  if (!value) return [];
  return [...new Set(value.split(",").map((p) => p.trim().toUpperCase()).filter(Boolean))];
}
