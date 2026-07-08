// ============================================================
// RESLU Spec System — Order-by engine (Phillip, 8 July 2026).
// BUILD-SPEC.md "Order-by engine — product deadlines from trade
// bookings": "an item a trade installs must be ordered [lead time]
// before that trade's works date. Sliding door frame (DR) <- Carpenter
// booked 21 Jul <- 3-week lead = order by 30 Jun."
//
// Pure, dependency-free domain logic — no Supabase/Next imports, plain
// data in/out — mirroring lib/trade-visits.ts / lib/board-cockpit.ts /
// lib/insurance.ts's exact shape (thin route + pure lib compute
// function) so this feed's thresholds/date math can never drift
// between server and any future client-side preview, and so the same
// function can be reused unchanged by P&P (ProcurementView), the
// project attention feed, and My Work.
//
// ------------------------------------------------------------
// THE MAPPING (BUILD-SPEC item 1 — "no new mapping table"):
// export presets (lib/export-presets.ts's ExportPresetRow) ALREADY
// carry both `prefixes[]` (item category prefixes, e.g. "TW"/"SW") and
// `contact_categories[]` (trade contact categories, e.g. "Plumber") —
// this one row IS the categories<->trade<->contacts mapping. Nothing
// new is modelled here; this file only derives dates from it.
//
// DERIVATION (BUILD-SPEC item 2), restated precisely:
//   1. For each unordered item (ordered_at is null), find its item
//      category prefix (items.category, references categories(prefix)
//      — see supabase/migrations/001_initial.sql line 160/199 and
//      types/index.ts's Item.category doc comment).
//   2. Find every preset whose `prefixes[]` includes that category
//      prefix (case-sensitive exact match — prefixes are always
//      upper-cased at write time by lib/export-presets.ts's
//      cleanPresetRow(), and items.category is itself an upper-cased
//      short code per the same convention, e.g. "TW"/"SW"/"DR" — no
///     case-folding needed here, unlike contact-category matching
//      below which IS free text and DOES need it).
//   3. For each such preset, find every "works date source" (a trade
//      visit OR a board-task booking placeholder) in the SAME PROJECT
//      as the item, whose linked contact's `category` (contacts.category,
//      free text) maps to that preset — via lib/export-presets.ts's
//      OWN pickPresetForContactCategory() two-step algorithm (contact_
//      categories containment, else name-heuristic), reused verbatim
//      here (imported, not reimplemented) so a "does this contact's
//      category match this preset" answer is identical everywhere in
//      the app (BookVisitPanel's Schedule auto-pick, and this engine).
//   4. Of every matching works-date source across every matching
//      preset, take the EARLIEST start date — "the earliest relevant
//      works date" per the spec's own wording.
//   5. order_by = that date minus (item.lead_time_weeks * 7) days.
//   6. Status classification (see OrderByStatus below).
//
// A SEPARATE, ADDITIVE amendment (Phillip, 8 July 2026, same note):
// "ANY unordered item without lead_time_weeks flags — even before a
// booking exists" — missingLeadTimes() below answers this
// independently of whether a works date was ever found, because
// lead-time hygiene should happen "at quoting time, not in a panic at
// booking time."
// ------------------------------------------------------------

import type { ExportPresetRow } from "@/types/round-export-batch";
import { pickPresetForContactCategory } from "@/lib/export-presets";

const DAY_MS = 24 * 60 * 60 * 1000;

// ------------------------------------------------------------
// Input shapes — deliberately minimal "just what this module needs"
// projections, not full DB row types, so callers (ProcurementView,
// the attention route, My Work) can pass through whatever subset of
// columns they already have selected without an extra remap step.
// Every date field is a plain yyyy-mm-dd DATE-ONLY string (Postgres
// `date` columns serialise this way through supabase-js) — this
// module NEVER touches time-of-day, only calendar dates (see "Date
// math / timezone assumptions" below).
// ------------------------------------------------------------

/** The subset of an `items` row this module needs. */
export interface OrderByItemInput {
  id: string;
  project_id: string;
  category: string; // references categories(prefix), e.g. "TW"
  lead_time_weeks: number | null;
  ordered_at: string | null; // date-only, null = not yet ordered
}

/** The subset of a `contacts` row this module needs. */
export interface OrderByContactInput {
  id: string;
  category: string | null; // free text, e.g. "Plumber"
}

/**
 * A single "works date source" — either a real trade_visits row or a
 * board_tasks booking placeholder, NORMALISED to this one shape by the
 * caller before calling into this module. This module does not care
 * which table a candidate came from; only `deriveOrderBy()`'s doc
 * comment on "placeholder vs confirmed visit precedence" below
 * addresses that distinction, and even there the answer is "no
 * precedence — earliest date wins regardless of source", so a single
 * flat shape is sufficient and keeps this module decoupled from both
 * trade_visits' and board_tasks' full column sets.
 */
export interface WorksDateSource {
  /** Stable id of the underlying row (visit id or board_task id) — carried through to a matched item's diagnostic breadcrumb only, not used in date math. */
  source_id: string;
  source_kind: "visit" | "board_task_booking";
  project_id: string;
  contact_id: string | null;
  /** The works date itself — trade_visits.start_date, or board_tasks.booking_date. Date-only yyyy-mm-dd. */
  start_date: string;
}

export type OrderByStatus = "ok" | "due_soon" | "overdue" | "no_lead_time" | "no_booking";

export interface OrderByResult {
  item_id: string;
  status: OrderByStatus;
  /** null when status is 'no_booking' (no relevant works date at all) OR 'no_lead_time' (a works date exists but there's nothing to subtract from it). */
  order_by: string | null;
  /** The earliest relevant works date found, if any — surfaced so a caller can show "works 21 Jul" alongside the derived order_by date without a second lookup (e.g. My Work's line format, BUILD-SPEC item 3). Null only when status is 'no_booking'. */
  works_date: string | null;
  /** Which works-date source produced `works_date` (earliest wins — see pickEarliestSource() below) — null when status is 'no_booking'. */
  source: WorksDateSource | null;
  /** The preset whose contact_categories/name-heuristic matched the winning source's contact, and whose prefixes covered the item's category — null when status is 'no_booking'. Surfaced for a "works — <preset name>" style label (My Work's "Order N items for {trade/preset name}"). */
  matched_preset: ExportPresetRow | null;
}

// ------------------------------------------------------------
// Date math — date-only comparison, no time-of-day drift.
//
// Every date this module handles is a DATE-ONLY string (yyyy-mm-dd,
// straight off a Postgres `date` column — trade_visits.start_date,
// board_tasks.booking_date, items.ordered_at). There is deliberately
// NO timestamp/time-of-day anywhere in this derivation, so unlike
// ProcurementView.tsx's riskFlag() (which anchors "today" to an
// explicit Australia/Adelaide calendar date via Intl.DateTimeFormat to
// avoid a server/client hydration mismatch when comparing a DATE
// column against a client-rendered "today"), this module parses every
// date as UTC-midnight-of-that-calendar-day (`Date.UTC`) and, when it
// needs "today" (only for status classification — due_soon/overdue),
// takes an explicit `now: Date` parameter from the caller (default
// `new Date()`) and truncates it via `Date.UTC` on ITS OWN calendar
// date components — this mirrors lib/board-cockpit.ts's
// isDateOnlyPast()/todayUtcMidnight() helpers exactly (same file-
// family, same "runtime-timezone-independent once you commit to UTC
// day-boundaries" reasoning), not lib/item-quantity.ts or
// ProcurementView's own Adelaide-anchored variant — those two
// conventions coexist elsewhere in this codebase for different
// reasons (see riskFlag()'s own doc comment on the server/client
// hydration bug it fixes), and this module's ALL-SERVER-SIDE-DERIVED
// (ProcurementView never runs this logic in a place where hydration
// mismatch is possible — see wiring notes in ProcurementView.tsx)
// usage make the simpler Date.UTC-only approach sufficient here. A
// caller rendering this module's date STRINGS in the browser (e.g. the
// "red if overdue" chip colour) recomputes overdue-ness from the
// already-serialised `status` field this module returns, never
// re-parses `order_by` client-side — so there is no drift surface.
// ------------------------------------------------------------

function parseDateOnly(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function todayUtcMidnight(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
}

function formatDateOnly(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** order_by = worksDate - (leadTimeWeeks * 7) days, date-only arithmetic. */
function subtractWeeks(worksDateStr: string, leadTimeWeeks: number): string {
  const ms = parseDateOnly(worksDateStr) - leadTimeWeeks * 7 * DAY_MS;
  return formatDateOnly(ms);
}

const DUE_SOON_WINDOW_DAYS = 7;

/**
 * Classifies an order_by date relative to today, per BUILD-SPEC item 2:
 *   - 'overdue': order_by has already passed (strictly before today).
 *   - 'due_soon': order_by is today or within the next 7 days
 *     inclusive ("within 7 days (<=7d)").
 *   - 'ok': order_by is more than 7 days in the future.
 * Callers needing 'no_lead_time'/'no_booking' set those BEFORE calling
 * this (this function is only reached once a real order_by date
 * exists) — see deriveOrderBy() below for the full state machine.
 */
function classifyOrderByDate(orderByStr: string, now: Date): "overdue" | "due_soon" | "ok" {
  const orderByMs = parseDateOnly(orderByStr);
  const todayMs = todayUtcMidnight(now);
  const diffDays = Math.round((orderByMs - todayMs) / DAY_MS);
  if (diffDays < 0) return "overdue";
  if (diffDays <= DUE_SOON_WINDOW_DAYS) return "due_soon";
  return "ok";
}

// ------------------------------------------------------------
// Preset <-> item-category matching.
//
// A preset "covers" an item's category when the item's category
// prefix appears in the preset's prefixes[] array. Prefixes are
// upper-cased and de-duped at write time (lib/export-presets.ts's
// cleanPresetRow()), and items.category is itself always an
// upper-cased short code (e.g. "TW", "DR") per the categories(prefix)
// convention this whole schema uses (see migration 001_initial.sql,
// components/items/ProcurementView.tsx's categoryName lookup keyed
// the same way) — so this is a plain exact-match array membership
// check, no case-folding needed (unlike contact-category matching,
// which IS free text and goes through pickPresetForContactCategory()'s
// own case-insensitive containment/heuristic logic instead).
//
// Edge case — item with no category: items.category is `not null` at
// the DB level (migration 001_initial.sql: `category text not null
// references categories(prefix)`) and Item's shared type
// (types/index.ts) reflects this as a non-nullable string — so "item
// with no category" cannot occur for a real row. Defensively, an
// empty-string category simply matches no preset's prefixes[] (no
// preset lists "" as a covered prefix), so it degrades to
// 'no_booking' rather than throwing — belt-and-braces only.
// ------------------------------------------------------------

function presetsCoveringCategory(presets: ExportPresetRow[], category: string): ExportPresetRow[] {
  return presets.filter((p) => p.prefixes.includes(category));
}

/**
 * Every works-date source in `sources` whose linked contact matches
 * ONE OF `coveringPresets`, via lib/export-presets.ts's
 * pickPresetForContactCategory() — reused verbatim, not reimplemented,
 * so this engine's notion of "does this contact map to this preset"
 * can never drift from BookVisitPanel's Schedule auto-pick.
 *
 * Edge case — contact with multiple categories: contacts.category is a
 * single free-text column (migration 013_boards_contacts.sql — NOT an
 * array), so "a contact with multiple categories" cannot occur in this
 * schema as written; a contact has exactly one category value (or
 * null). If a future schema change ever made this an array, the
 * natural extension would be "matches if ANY of the contact's
 * categories picks a covering preset" — noted here for that future
 * reader, not implemented speculatively now.
 *
 * Edge case — contact with no category (null): pickPresetForContactCategory()
 * itself returns null for a null/empty category (see that function's
 * own doc comment), so a source whose contact has no category, or no
 * contact_id at all (an unassigned visit/placeholder), simply never
 * matches any preset here — it contributes no candidate date, exactly
 * like a source with a category that matches nothing.
 *
 * Edge case — no matching preset for a contact's category: returns an
 * empty filter result for that source, same as above — the item this
 * feeds into then has zero candidates and lands in 'no_booking' unless
 * another source/preset combination does match.
 */
function matchingSources(
  sources: WorksDateSource[],
  contactsById: Map<string, OrderByContactInput>,
  coveringPresets: ExportPresetRow[]
): { source: WorksDateSource; preset: ExportPresetRow }[] {
  const results: { source: WorksDateSource; preset: ExportPresetRow }[] = [];
  for (const source of sources) {
    if (!source.contact_id) continue;
    const contact = contactsById.get(source.contact_id);
    if (!contact) continue;
    const picked = pickPresetForContactCategory(coveringPresets, contact.category);
    if (picked) results.push({ source, preset: picked });
  }
  return results;
}

/**
 * Picks the earliest-dated (source, preset) pair from a candidate
 * list. Ties (two sources on the exact same date) resolve to whichever
 * appears first in the input array — a stable, deterministic (if
 * arbitrary) tiebreak; the spec gives no basis for preferring one
 * trade/contact over another on an exact date tie, and Array.prototype
 * .reduce below is already stable for equal comparisons, so no
 * additional tiebreak logic is introduced.
 *
 * Edge case — placeholder vs confirmed visit precedence: NONE. Per
 * BUILD-SPEC item 2's own wording ("earliest relevant works date"),
 * this engine treats every WorksDateSource identically regardless of
 * whether it originated from a real trade_visits row (any status —
 * unconfirmed/tentative/confirmed/proposed_change; a declined visit is
 * expected to be filtered OUT by the caller before it ever reaches
 * this module, since a declined booking is not a real works date — see
 * the "caller responsibilities" note in the module-level doc comment
 * below) or a board_tasks booking placeholder (booking_date with no
 * linked trade_visits row yet). A firm, confirmed visit is not
 * preferred over a tentative placeholder — the whole point of this
 * engine is to nudge ordering EARLY, before a booking is even
 * confirmed, so under-reacting to a placeholder date would work
 * directly against that goal. If multiple candidate visits/placeholders
 * exist for the same item, the EARLIEST one always wins (per spec),
 * never the most-confirmed one.
 */
function pickEarliestSource(
  candidates: { source: WorksDateSource; preset: ExportPresetRow }[]
): { source: WorksDateSource; preset: ExportPresetRow } | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, current) =>
    parseDateOnly(current.source.start_date) < parseDateOnly(earliest.source.start_date) ? current : earliest
  );
}

// ------------------------------------------------------------
// Main derivation
// ------------------------------------------------------------

/**
 * Derives the order-by status/date for every UNORDERED item in
 * `items` (items with a non-null ordered_at are skipped entirely —
 * BUILD-SPEC item 2: "for each item not yet ordered (no ordered_at)").
 *
 * Caller responsibilities (kept out of this pure module deliberately,
 * same "pure compute, route does the fetching/filtering" split every
 * other lib/*.ts attention-style module in this codebase uses):
 *   - `sources` should already exclude visits with status='declined'
 *     (a declined visit is not a real works date to order against) and
 *     any soft-deleted (deleted_at not null) visits/board_tasks — this
 *     module has no `deleted_at`/`status` field on WorksDateSource at
 *     all, by design, so it can't accidentally forget this filter; the
 *     caller (P&P's data-loading route, the attention route, My Work)
 *     is expected to pre-filter exactly once, in one place, rather
 *     than every consumer of this module re-implementing the same
 *     "which visits count" rule.
 *   - `items`/`sources`/`contacts` may span MULTIPLE projects (e.g. a
 *     cross-project attention feed) — this function itself scopes
 *     every item's candidate sources to `source.project_id ===
 *     item.project_id` internally, so passing a multi-project batch in
 *     one call is safe and avoids the caller having to pre-group by
 *     project.
 *
 * Edge case — multiple candidate visits: handled via
 * matchingSources()+pickEarliestSource() above — every matching source
 * across every covering preset is collected, then the single earliest
 * wins.
 *
 * Edge case — no matching preset at all for the item's category: zero
 * covering presets means zero candidate sources means 'no_booking' —
 * indistinguishable at the item level from "presets matched but no
 * contact/date lined up"; BOTH are simply "no relevant works date
 * could be found," which is exactly the no_booking definition (BUILD-
 * SPEC item 2's own wording), so no separate status is needed for
 * "unmapped category" vs "mapped but nothing booked yet."
 */
export function deriveOrderBy(
  items: OrderByItemInput[],
  presets: ExportPresetRow[],
  contacts: OrderByContactInput[],
  sources: WorksDateSource[],
  now: Date = new Date()
): OrderByResult[] {
  const contactsById = new Map(contacts.map((c) => [c.id, c]));
  // Cache presets-covering-category per category prefix — a project's
  // item list commonly has many rows sharing the same handful of
  // category prefixes (e.g. dozens of TW items), so this avoids
  // re-filtering the full presets array once per item unnecessarily.
  const coveringPresetsByCategory = new Map<string, ExportPresetRow[]>();
  function coveringPresetsFor(category: string): ExportPresetRow[] {
    let cached = coveringPresetsByCategory.get(category);
    if (!cached) {
      cached = presetsCoveringCategory(presets, category);
      coveringPresetsByCategory.set(category, cached);
    }
    return cached;
  }

  const results: OrderByResult[] = [];

  for (const item of items) {
    if (item.ordered_at) continue; // already ordered — out of scope entirely, per spec.

    const coveringPresets = coveringPresetsFor(item.category);
    const projectSources = sources.filter((s) => s.project_id === item.project_id);
    const candidates =
      coveringPresets.length > 0 ? matchingSources(projectSources, contactsById, coveringPresets) : [];
    const winner = pickEarliestSource(candidates);

    if (!winner) {
      results.push({
        item_id: item.id,
        status: "no_booking",
        order_by: null,
        works_date: null,
        source: null,
        matched_preset: null,
      });
      continue;
    }

    if (item.lead_time_weeks === null || item.lead_time_weeks === undefined) {
      results.push({
        item_id: item.id,
        status: "no_lead_time",
        order_by: null,
        works_date: winner.source.start_date,
        source: winner.source,
        matched_preset: winner.preset,
      });
      continue;
    }

    const orderBy = subtractWeeks(winner.source.start_date, item.lead_time_weeks);
    const status = classifyOrderByDate(orderBy, now);
    results.push({
      item_id: item.id,
      status,
      order_by: orderBy,
      works_date: winner.source.start_date,
      source: winner.source,
      matched_preset: winner.preset,
    });
  }

  return results;
}

// ------------------------------------------------------------
// Missing lead times — a SEPARATE, additive amendment (Phillip, 8 July
// 2026): "ANY unordered item without lead_time_weeks flags — even
// before a booking exists ... so lead-time hygiene happens at quoting
// time, not in a panic at booking time." This is intentionally NOT
// filtered by whether a works date was found — it is a strict superset
// of the 'no_lead_time' items deriveOrderBy() above returns (those are
// exactly the subset that ALSO has a relevant works date). A caller
// wanting "the amber dot on every row missing a lead time" uses this
// function directly rather than deriving it from deriveOrderBy()'s
// output, since deriveOrderBy() only reports 'no_lead_time' for items
// that cleared the "found a works date" hurdle first.
// ------------------------------------------------------------

export interface MissingLeadTimeItem {
  item_id: string;
  project_id: string;
}

/**
 * Every unordered item (ordered_at null) with no lead_time_weeks set,
 * regardless of booking status. Deliberately ignores `sources`/
 * `presets`/`contacts` entirely — this is a pure lead-time-hygiene
 * check on `items` alone.
 */
export function missingLeadTimes(items: OrderByItemInput[]): MissingLeadTimeItem[] {
  const results: MissingLeadTimeItem[] = [];
  for (const item of items) {
    if (item.ordered_at) continue;
    if (item.lead_time_weeks === null || item.lead_time_weeks === undefined) {
      results.push({ item_id: item.id, project_id: item.project_id });
    }
  }
  return results;
}

// ------------------------------------------------------------
// Small presentational helper — shared by every surface that needs to
// turn an OrderByResult into a one-line summary (My Work's "Order N
// items for {trade/preset name} — works {date}", the attention group's
// per-item label). Kept here (not duplicated in each consuming route)
// since it's still pure string formatting with zero I/O.
// ------------------------------------------------------------

/** DD/MM formatting — mirrors app/api/my-work/route.ts's formatWorksDate() exactly (same fixed non-locale format, same date-only input), so a "works 21/07" suffix looks identical whether it comes from a board-cockpit booking_date or this engine's works_date. */
export function formatOrderByWorksDate(dateOnly: string): string {
  const [, month, day] = dateOnly.split("-");
  return `${day}/${month}`;
}
