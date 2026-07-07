// ============================================================
// RESLU Spec System — "Export + board batch" round (Phillip, 7 July
// 2026) — trade export presets. Pure, dependency-free domain logic —
// no Supabase/Next imports — mirroring lib/phase-template.ts's exact
// shape (a code-level FALLBACK constant kept byte-for-byte in sync
// with app_settings's seeded default, plus small pure helpers reused
// by both the API route and the export dialog).
//
// "Trade booking document pack" round (8 July 2026) additions:
// cleanPresetRow now also trims/validates contact_categories, and this
// file gains pickPresetForContactCategory() + the small name-heuristic
// fallback it uses — BookVisitPanel's "Schedule" auto-pick (BUILD-
// SPEC.md item 2: "match booking contact's category against presets'
// contact_categories ... else name-heuristic ... else full schedule").
// Kept in this file (not a new lib/trade-doc-pack.ts) because it's
// pure preset-selection logic with zero trade-visit-specific
// knowledge — the exact same "pure domain logic, no framework
// imports" scope this file already has.
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
  contact_categories?: unknown;
}): ExportPresetRow | null {
  const name = typeof row?.name === "string" ? row.name.trim() : "";
  if (!name) return null;
  if (!Array.isArray(row?.prefixes)) return null;
  const prefixes = row.prefixes
    .filter((p): p is string => typeof p === "string" && p.trim() !== "")
    .map((p) => p.trim().toUpperCase());
  if (prefixes.length === 0) return null;

  // contact_categories is OPTIONAL — absent/not-an-array simply means
  // "this preset doesn't declare an applies-to category," not a
  // validation error (unlike prefixes, which a preset cannot function
  // without). Free-text values are trimmed only, NOT upper-cased —
  // unlike category prefixes (a fixed short code, "TW"/"SW"), a
  // contact category is a longer human label ("Plumber") whose casing
  // is cosmetic; pickPresetForContactCategory() below does its own
  // case-insensitive comparison at match time instead.
  const cleanedCategories = Array.isArray(row?.contact_categories)
    ? [
        ...new Set(
          row.contact_categories
            .filter((c): c is string => typeof c === "string" && c.trim() !== "")
            .map((c) => c.trim())
        ),
      ]
    : [];

  const result: ExportPresetRow = { name, prefixes: [...new Set(prefixes)] };
  if (cleanedCategories.length > 0) result.contact_categories = cleanedCategories;
  return result;
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

// ------------------------------------------------------------
// "Trade booking document pack" round — Schedule auto-pick.
//
// BUILD-SPEC.md item 2's exact three-step fallback: "match booking
// contact's category against presets' contact_categories (case-
// insensitive containment), else name-heuristic (category contains
// 'plumb' → preset named Plumber etc.), else full schedule." Both
// helpers below are pure string logic — no Supabase/Next imports —
// consumed by BookVisitPanel.tsx (client-side, once presets + the
// selected contact's category are both in hand) and safe to reuse
// server-side too if a future caller needs the same decision without
// a round-trip.
// ------------------------------------------------------------

/**
 * Name-heuristic fallback table — a short, deliberately small set of
 * trade-keyword -> preset-name-substring pairs for the common trades
 * this studio actually books (BUILD-SPEC's own example: "category
 * contains 'plumb' → preset named Plumber"). Matched against BOTH the
 * contact's category text and each preset's name, case-insensitively,
 * substring-only (no stemming/fuzzy match) — deliberately simple over
 * clever: a studio that renames "Plumber" to "Plumbing Sub" still
 * matches on "plumb", and a category of "Licensed Plumber" still
 * matches too, without needing every possible phrasing enumerated.
 */
const TRADE_KEYWORDS = [
  "plumb",
  "electric",
  "tiler",
  "tiling",
  "carpen",
  "paint",
  "plaster",
  "cabinet",
  "waterproof",
  "concret",
  "brick",
  "roof",
  "glaz",
  "landscap",
  "hvac",
  "airconditio",
] as const;

/**
 * Step 1 — case-insensitive CONTAINMENT match (BUILD-SPEC's own
 * wording), tried in both directions: the contact's category containing
 * a preset's declared contact_categories entry, OR vice versa. This
 * catches the literal cases — a contact category of "Licensed Plumber"
 * containing a preset's contact_categories entry "Plumber", or a
 * preset declaring "Plumbing" against a contact category of "Plumbing"
 * exactly. It does NOT catch every real-world phrasing (e.g. a contact
 * category "Plumbing" against a preset's declared category "Plumber" —
 * neither is a substring of the other), which is exactly why the
 * name-heuristic step below exists as the next fallback rather than
 * relying on containment alone.
 */
function categoryContainsMatch(contactCategory: string, presetCategories: string[]): boolean {
  const needle = contactCategory.trim().toLowerCase();
  if (!needle) return false;
  return presetCategories.some((c) => {
    const hay = c.trim().toLowerCase();
    if (!hay) return false;
    return hay.includes(needle) || needle.includes(hay);
  });
}

/** Step 2 — name-heuristic: does the contact's category and the preset's own name share a common trade keyword? */
function nameHeuristicMatch(contactCategory: string, presetName: string): boolean {
  const category = contactCategory.trim().toLowerCase();
  const name = presetName.trim().toLowerCase();
  if (!category || !name) return false;
  return TRADE_KEYWORDS.some((kw) => category.includes(kw) && name.includes(kw));
}

/**
 * Picks the single best-matching preset for a booking contact's
 * category, or null when nothing matches (the caller's own "else full
 * schedule" default — this function deliberately never returns a
 * guessed preset just to avoid returning null). Step 1
 * (contact_categories containment) is tried across every preset
 * first, so an explicit studio-configured mapping always wins over the
 * generic keyword heuristic even if a preset's name would ALSO have
 * matched the heuristic. Step 2 (name heuristic) only runs if no
 * preset matched step 1 at all. `contactCategory` of null/empty always
 * returns null (nothing to match against — a contact with no category
 * set can't drive an auto-pick).
 */
export function pickPresetForContactCategory(
  presets: ExportPresetRow[],
  contactCategory: string | null | undefined
): ExportPresetRow | null {
  const category = contactCategory?.trim();
  if (!category) return null;

  const byContactCategories = presets.find(
    (p) => p.contact_categories && p.contact_categories.length > 0 && categoryContainsMatch(category, p.contact_categories)
  );
  if (byContactCategories) return byContactCategories;

  const byNameHeuristic = presets.find((p) => nameHeuristicMatch(category, p.name));
  if (byNameHeuristic) return byNameHeuristic;

  return null;
}
