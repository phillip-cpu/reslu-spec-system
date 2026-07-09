// ============================================================
// RESLU Spec System — CPD point tracker.
// Pure, dependency-free domain logic (no Supabase/Next imports) — same
// shape as lib/my-work.ts / lib/export-presets.ts: consumed by BOTH the
// API routes (server) and the CPD page / My Work nudge (client), so the
// year-window math and pace check can never drift between the two.
//
// BUILD-SPEC.md "CPD point tracker": the annual target, licence-year
// start month, and CBS category split were never resolved to real
// numbers. This file ships sensible, ADMIN-EDITABLE defaults —
// FALLBACK_CPD_DEFAULTS below — stored in app_settings('cpd_defaults')
// once an admin has saved a value via Settings -> "CPD" (see
// app/api/settings/cpd-defaults/route.ts), same "code fallback, not a
// migration seed" convention as FALLBACK_EXPORT_PRESETS/
// FALLBACK_PHASE_TEMPLATE.
//
// Per-user override (e.g. a part-time team member on a lower personal
// target) is EXPLICITLY SKIPPED in this v1 — see CpdDefaults's own doc
// comment below for the extension point a future round would need.
// ============================================================

import type { CpdDefaults, CpdEntryLike, CpdYearWindow } from "@/types/cpd";

/**
 * Studio-wide defaults, used whenever app_settings('cpd_defaults') has
 * never been written. year_start_month is 1-12 (7 = July — an
 * Australian financial-year-style licence year, not calendar year).
 *
 * NOT per-user: this codebase has no per-profile CPD override column in
 * v1 (BUILD-SPEC.md's placeholder was never resolved to "does every
 * team member have the same target"). A future round adding one would
 * add a nullable `cpd_annual_target_override` column to `profiles` and
 * have GET /api/cpd prefer it over this app_settings value when set —
 * a purely additive change, not a rework of anything below.
 */
export const FALLBACK_CPD_DEFAULTS: CpdDefaults = {
  annual_target: 12,
  year_start_month: 7,
};

/** Validates a raw PUT body into a clean CpdDefaults, or null if invalid. Mirrors lib/bank-details.ts's cleanBankDetails()/lib/export-presets.ts's cleanPresetRow() shape (small pure validators feeding both the PUT route and, if ever needed, an optimistic client update). */
export function cleanCpdDefaults(raw: unknown): CpdDefaults | null {
  if (!raw || typeof raw !== "object") return null;
  const annual_target = Number((raw as { annual_target?: unknown }).annual_target);
  const year_start_month = Number((raw as { year_start_month?: unknown }).year_start_month);
  if (!Number.isFinite(annual_target) || annual_target <= 0) return null;
  if (!Number.isInteger(year_start_month) || year_start_month < 1 || year_start_month > 12) return null;
  return { annual_target, year_start_month };
}

/** yyyy-mm-dd from UTC date parts — deliberately NOT toISOString() (which is UTC-based already but includes a time component we never want here) and NOT toLocaleDateString (locale/ICU dependent — see MyWorkWorkspace.tsx's own SHORT_MONTHS comment for why this codebase avoids Intl for exactly this reason). */
function toISODate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * The current CPD licence-year window containing `now`, given a
 * 1-12 `yearStartMonth`. E.g. yearStartMonth=7 (July), now = any date
 * in Jul 2026 - Jun 2027 inclusive -> { start: '2026-07-01', end:
 * '2027-06-30' }. `end` is INCLUSIVE (the last calendar day of the
 * window, not the first day of the next one) — every caller (the CPD
 * page's entries-in-window query, the My Work nudge's points-to-date
 * sum) uses `end` as an inclusive upper bound (`.lte("activity_date",
 * end)`), matching how `start` is used as an inclusive lower bound.
 */
export function computeCpdYearWindow(now: Date, yearStartMonth: number): CpdYearWindow {
  const month = now.getUTCMonth() + 1; // 1-12
  const startYear = month >= yearStartMonth ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(startYear, yearStartMonth - 1, 1));
  const nextStart = new Date(Date.UTC(startYear + 1, yearStartMonth - 1, 1));
  const end = new Date(nextStart);
  end.setUTCDate(end.getUTCDate() - 1); // last day of the window, inclusive
  return { start: toISODate(start), end: toISODate(end) };
}

/**
 * How far through the window `now` sits, as a 0..1 fraction — 0 at (or
 * before) `start`, 1 at (or after) the end of `end`'s calendar day.
 * Used by isBehindPace() below for the pro-rata target
 * (target * elapsedFraction).
 */
export function elapsedFraction(now: Date, window: CpdYearWindow): number {
  const startMs = new Date(`${window.start}T00:00:00Z`).getTime();
  const endMs = new Date(`${window.end}T23:59:59Z`).getTime();
  const nowMs = now.getTime();
  if (nowMs <= startMs) return 0;
  if (nowMs >= endMs) return 1;
  return (nowMs - startMs) / (endMs - startMs);
}

/**
 * Whole calendar months elapsed since `window.start` (0 for the first
 * partial month). Drives the nudge's "only after 2+ months into the
 * year" gate — BUILD-SPEC.md's brief for the My Work nudge — so a
 * team member isn't told they're "behind pace" three days into a fresh
 * licence year, when a pro-rata target of ~1 point is still noise.
 */
export function monthsElapsedSinceStart(now: Date, window: CpdYearWindow): number {
  const start = new Date(`${window.start}T00:00:00Z`);
  let months =
    (now.getUTCFullYear() - start.getUTCFullYear()) * 12 + (now.getUTCMonth() - start.getUTCMonth());
  if (now.getUTCDate() < start.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * The My Work nudge's exact rule (BUILD-SPEC.md / this round's brief):
 * "when the user's pro-rata pace is behind (points-to-date < target x
 * elapsed-fraction, only after 2+ months into the year)". Pure — takes
 * the already-summed pointsToDate rather than raw entries, so both the
 * API's server-side sum and any future client-side re-derivation call
 * this the same way.
 */
export function isBehindPace(
  pointsToDate: number,
  annualTarget: number,
  now: Date,
  window: CpdYearWindow
): boolean {
  if (monthsElapsedSinceStart(now, window) < 2) return false;
  const proRataTarget = annualTarget * elapsedFraction(now, window);
  return pointsToDate < proRataTarget;
}

/** "4" or "4.5" — trims a redundant ".0" but keeps one real decimal place (points are numeric(5,2), but whole/half numbers are the overwhelmingly common case and read better unpadded). Shared by the CPD page header and the My Work nudge line so "4 / 12 points" never disagrees with itself. */
export function formatPoints(n: number): string {
  const rounded = Math.round(n * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(Number(rounded.toFixed(2)));
}

/** Sums `.points` across a list of entries (already filtered to the target window/user) — the one place this addition happens, reused by both GET /api/cpd's header total and GET /api/my-work's nudge sum. */
export function sumPoints(entries: { points: number }[]): number {
  return entries.reduce((total, e) => total + Number(e.points), 0);
}

// ------------------------------------------------------------
// Validation — POST/PATCH /api/cpd body cleaning. Shared by both
// routes so a create and an edit can never disagree on what's valid.
// ------------------------------------------------------------

export interface CleanCpdEntryResult {
  activity_title: string;
  provider: string | null;
  activity_date: string;
  points: number;
  category: string | null;
  notes: string | null;
}

/**
 * Validates the required/free-editable fields of a create/edit body.
 * Returns null (caller responds 400) if activity_title, activity_date,
 * or points are missing/invalid. Evidence fields (evidence_path/
 * evidence_filename) are deliberately NOT handled here — they follow
 * the signed-upload two-step flow and are validated separately by the
 * route itself (same separation ContactDocumentsPanel's upload flow
 * already established), not bundled into this generic field cleaner.
 */
export function cleanCpdEntryFields(raw: {
  activity_title?: unknown;
  provider?: unknown;
  activity_date?: unknown;
  points?: unknown;
  category?: unknown;
  notes?: unknown;
}): CleanCpdEntryResult | null {
  const activity_title = typeof raw.activity_title === "string" ? raw.activity_title.trim() : "";
  if (!activity_title) return null;

  const activity_date = typeof raw.activity_date === "string" ? raw.activity_date.trim() : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(activity_date)) return null;

  const points = Number(raw.points);
  if (!Number.isFinite(points) || points <= 0) return null;

  const provider = typeof raw.provider === "string" && raw.provider.trim() ? raw.provider.trim() : null;
  const category = typeof raw.category === "string" && raw.category.trim() ? raw.category.trim() : null;
  const notes = typeof raw.notes === "string" && raw.notes.trim() ? raw.notes.trim() : null;

  return {
    activity_title,
    provider,
    activity_date,
    points: Math.round(points * 100) / 100,
    category,
    notes,
  };
}

/** Suggested category values — shown as an HTML <datalist> on the add form (free text underneath, per migration 047's own "no CHECK/enum, CBS split never resolved" note). Not exhaustive, not enforced. */
export const CPD_CATEGORY_SUGGESTIONS = ["Technical", "Business", "Compliance", "Safety"] as const;

// ------------------------------------------------------------
// CSV export — client-side only (no server route). No CSV-export
// precedent exists elsewhere in this codebase to reuse (lib/csv.ts is
// the PROJECT IMPORT parser, a different direction entirely, and is
// out of this task's edit boundary) — this is a small from-scratch
// builder, deliberately simple: one row per entry, RFC-4180-ish quoting
// (wrap in quotes + escape embedded quotes whenever a field contains a
// comma/quote/newline), audit-friendly column set (includes who logged
// it when exporting the admin "All team" view, so the export is
// self-contained without needing a second profiles lookup).
// ------------------------------------------------------------

const CSV_HEADERS = [
  "Date",
  "Activity",
  "Provider",
  "Category",
  "Points",
  "Notes",
  "Logged by",
  "Evidence on file",
] as const;

function csvField(value: string): string {
  // Formula-injection guard: a category/title/notes value starting with
  // =, +, -, or @ would execute as a formula if the export is opened in
  // Excel/Sheets (e.g. `=HYPERLINK(...)`). Prefixing with a tab defeats
  // the leading-character sniff those apps use without visibly altering
  // the cell's displayed text.
  const guarded = /^[=+\-@]/.test(value) ? `\t${value}` : value;
  if (/[",\n]/.test(guarded)) return `"${guarded.replace(/"/g, '""')}"`;
  return guarded;
}

/**
 * Builds a CSV string (headers + one row per entry) from already-loaded
 * entries. `entries` should already be sorted the way the caller wants
 * them to export (the CPD page passes them in the same order they're
 * displayed). `personLabel` resolves an entry to a display name for the
 * "Logged by" column — pass a function that looks up the entry's own
 * user_id/profile when exporting the admin all-team view, or a constant
 * function returning the current user's name for the own-entries view.
 */
export function cpdEntriesToCsv<T extends CpdEntryLike>(
  entries: T[],
  personLabel: (entry: T) => string
): string {
  const rows = entries.map((e) =>
    [
      e.activity_date,
      e.activity_title,
      e.provider ?? "",
      e.category ?? "",
      formatPoints(e.points),
      e.notes ?? "",
      personLabel(e),
      e.evidence_path ? "Yes" : "No",
    ]
      .map((v) => csvField(String(v)))
      .join(",")
  );
  return [CSV_HEADERS.join(","), ...rows].join("\r\n");
}
