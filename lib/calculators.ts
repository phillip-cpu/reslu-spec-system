// ============================================================
// RESLU Spec System — Round B: Calculators pure math.
// BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 4:
// "calculators incl. materials price list". DECISIONS paragraph above
// item 5: NO framing defaults — every input this module consumes is
// caller-supplied; nothing here substitutes a "typical" value for a
// missing one (a missing/null required input simply can't be computed
// — see each function's own null-handling below).
//
// Deliberately dependency-free and unit-testable (no Supabase/Next
// imports here), same convention as lib/estimate.ts — used by both the
// client component (components/calculators/CalculatorsPanel.tsx, for
// live as-you-type results) and, if ever needed server-side (e.g. a
// future Aria tool), without duplicating the formulas.
// ============================================================

import type {
  BinPackResult,
  FrameOpening,
  PlasterboardInputs,
  PlasterboardResult,
  SheetSizeMm,
  TimberFrameInputs,
  TimberFrameMemberList,
  TimberFrameResult,
} from "@/types/round-b";
import { STOCK_LENGTHS_M } from "@/types/round-b";

// ------------------------------------------------------------
// Shared helpers
// ------------------------------------------------------------

const MM_PER_M = 1000;

// ------------------------------------------------------------
// Timber frame calculator
//
// BUILD-SPEC.md formulas (as briefed):
//   - studs count = ceil(wall length / spacing) + 1 (end stud)
//   - plates: one top + one bottom plate run the full wall length;
//     double top plate toggle adds a second full-length top plate
//   - noggin rows = ceil(height / 1350) − 1 (rows of horizontal
//     blocking at ≤1350mm vertical centres — the max spacing before
//     a second row is required)
//   - jack studs + lintel per opening (one lintel spans the opening,
//     two jack studs support it)
// ------------------------------------------------------------

/**
 * Stud count for a wall run: ceil(length / spacing) + 1. The "+1" is
 * the end stud every run needs beyond the interior studs the spacing
 * division accounts for (a run of N spacing gaps needs N+1 studs to
 * bound them). Returns 0 if either input is missing/non-positive —
 * this is a pure function, it does not guess a spacing.
 */
export function studCount(wallLengthMm: number, spacingMm: number): number {
  if (wallLengthMm <= 0 || spacingMm <= 0) return 0;
  return Math.ceil(wallLengthMm / spacingMm) + 1;
}

/**
 * Noggin row count: ceil(height / 1350) − 1. A wall under 1350mm tall
 * needs zero noggin rows (ceil(<1350/1350) − 1 = 1 − 1 = 0); every full
 * 1350mm increment of height beyond that adds one more row of
 * horizontal blocking. Clamped to 0 (never negative) for a very short
 * wall height.
 */
export function nogginRowCount(wallHeightMm: number): number {
  if (wallHeightMm <= 0) return 0;
  return Math.max(0, Math.ceil(wallHeightMm / 1350) - 1);
}

/**
 * Computes the full member list for a timber frame run. Returns all
 * fields as 0/empty when a required input (wall_length_mm,
 * wall_height_mm, stud_spacing_mm) is null — the caller (UI) is
 * responsible for not showing a result until the required fields are
 * filled; this function never substitutes a default for a missing
 * value (BUILD-SPEC.md "NO framing defaults").
 */
export function timberFrameMembers(inputs: TimberFrameInputs): TimberFrameMemberList {
  const { wall_length_mm, wall_height_mm, stud_spacing_mm, double_top_plate, openings } = inputs;

  if (!wall_length_mm || !wall_height_mm || !stud_spacing_mm) {
    return { studs: 0, plate_lm: 0, jack_studs: 0, lintels: 0, noggin_rows: 0, noggins: 0 };
  }

  // Jack studs: 2 per opening (one either side), or 4 if that opening
  // has "double stud" checked (2 either side — wider spans/load-
  // bearing headers) — 7 July 2026, Phillip.
  const validOpenings = openings.filter((o) => (o.width_mm ?? 0) > 0);
  const openingCount = validOpenings.length;
  const jack_studs = validOpenings.reduce((sum, o) => sum + (o.double_stud ? 4 : 2), 0);
  const lintels = openingCount;

  // Regular studs: wall length NET of opening widths (7 July 2026,
  // Phillip — openings weren't reducing the stud count at all before
  // this; the wall run "under" a door/window doesn't need common studs
  // at spacing through it, since the jack studs + lintel take over
  // there instead). Clamped at 0 so an opening total that (implausibly)
  // exceeds the wall length can't go negative.
  const openingWidthTotalMm = validOpenings.reduce((sum, o) => sum + (o.width_mm as number), 0);
  const studWallLengthMm = Math.max(0, wall_length_mm - openingWidthTotalMm);
  const studs = studCount(studWallLengthMm, stud_spacing_mm);

  // Bottom plate + top plate, both full wall length regardless of
  // openings (they tie the whole frame together — a door's section of
  // bottom plate gets cut out on site, not left off the purchase list
  // entirely) — 7 July 2026, Phillip: studs reduce for openings,
  // plates don't. Double top plate adds a second full-length top
  // plate run.
  const plateRuns = double_top_plate ? 3 : 2;
  const plate_lm = (plateRuns * wall_length_mm) / MM_PER_M;

  const noggin_rows = nogginRowCount(wall_height_mm);
  // One noggin piece per stud bay per row — (studs − 1) bays between
  // `studs` studs, i.e. roughly one noggin per stud spacing gap, per
  // row. Openings reduce the number of full stud bays needing a
  // noggin cut, but per BUILD-SPEC.md's brief this calculator counts
  // gross bays (studs − 1) per row — a deliberately simple, slightly
  // conservative (over-count, never under-count materials) estimate
  // rather than modelling exactly which bays an opening interrupts.
  const bays = Math.max(0, studs - 1);
  const noggins = noggin_rows * bays;

  return { studs, plate_lm, jack_studs, lintels, noggin_rows, noggins };
}

/**
 * Greedy bin-packing: given a list of required cut lengths (metres,
 * e.g. individual stud lengths, plate run lengths already split into
 * per-stock-length purchases) and the fixed stock-length catalogue,
 * pack pieces onto stock lengths to minimise total offcut.
 *
 * Algorithm (first-fit decreasing — a standard, well-understood
 * approximation for 1D bin packing; optimal bin packing is NP-hard, so
 * an exact solver is not attempted here):
 *   1. Sort required lengths descending.
 *   2. For each length, try to fit it into the stock length already
 *      "open" (purchased in this run) with the least remaining
 *      capacity that can still fit it (best-fit among open bins) —
 *      this packs bins tighter than plain first-fit before opening a
 *      new one.
 *   3. If it fits no open bin, open a new stock length: the SMALLEST
 *      catalogue length that is ≥ the piece (never buy a 6.0m length
 *      for a 2.5m stud) — falls back to the largest catalogue length
 *      (accepting the piece won't fit in one length, i.e. it must be
 *      spliced/is out of range) only if the piece exceeds every stock
 *      length.
 */
export function binPackLengths(
  requiredLengthsM: number[],
  stockLengthsM: readonly number[] = STOCK_LENGTHS_M
): BinPackResult {
  const catalogue = [...stockLengthsM].sort((a, b) => a - b);
  const totalRequired = requiredLengthsM.reduce((s, v) => s + v, 0);

  if (requiredLengthsM.length === 0 || catalogue.length === 0) {
    return { lengths_to_buy: [], total_lm_purchased: 0, total_lm_required: totalRequired, waste_pct: 0 };
  }

  const sorted = [...requiredLengthsM].filter((v) => v > 0).sort((a, b) => b - a);

  // Open bins: each { stockLength, remaining }.
  const bins: { stockLength: number; remaining: number }[] = [];

  for (const piece of sorted) {
    // Best-fit: among open bins that can still fit this piece, pick
    // the one with the smallest remaining capacity (tightest fit).
    let bestIdx = -1;
    let bestRemaining = Infinity;
    for (let i = 0; i < bins.length; i++) {
      if (bins[i].remaining >= piece && bins[i].remaining < bestRemaining) {
        bestIdx = i;
        bestRemaining = bins[i].remaining;
      }
    }

    if (bestIdx >= 0) {
      bins[bestIdx].remaining -= piece;
      continue;
    }

    // Open a new bin: smallest catalogue length ≥ piece, else the
    // largest available (piece exceeds every stock length — flagged
    // via the resulting negative "remaining", which surfaces as extra
    // waste rather than silently under-buying).
    const fitLength = catalogue.find((len) => len >= piece) ?? catalogue[catalogue.length - 1];
    bins.push({ stockLength: fitLength, remaining: fitLength - piece });
  }

  const lengths_to_buy = bins.map((b) => b.stockLength).sort((a, b) => a - b);
  const total_lm_purchased = lengths_to_buy.reduce((s, v) => s + v, 0);
  const waste_pct = total_lm_purchased > 0
    ? Math.max(0, (total_lm_purchased - totalRequired) / total_lm_purchased)
    : 0;

  return {
    lengths_to_buy,
    total_lm_purchased,
    total_lm_required: totalRequired,
    waste_pct,
  };
}

/**
 * Expands a TimberFrameMemberList into individual cut lengths (metres)
 * ready for binPackLengths(). Studs are cut to wall height (mm→m).
 * Jack studs are cut to EACH opening's own head height when given (they
 * run from the bottom plate to the underside of the lintel, not the
 * full wall height) — falling back to the full wall height for an
 * opening with no stated height, same as before this field existed
 * (7 July 2026, Phillip). Plates and noggins are already linear-metre
 * totals from timberFrameMembers() and are treated as single "pieces"
 * of that total length each (a plate run longer than the longest stock
 * length will, per binPackLengths' fallback, be flagged via waste
 * rather than silently mis-packed — splitting a plate run into
 * per-stock-length segments is a follow-up refinement, not attempted
 * here since BUILD-SPEC.md's brief describes the member list + bin
 * pack at this level of granularity, not per-run splicing logic).
 */
export function timberFrameCutLengths(
  inputs: TimberFrameInputs,
  members: TimberFrameMemberList
): number[] {
  const heightM = (inputs.wall_height_mm ?? 0) / MM_PER_M;
  const lengths: number[] = [];

  for (let i = 0; i < members.studs; i++) lengths.push(heightM);
  // Jack studs (per-opening height, doubled if flagged) + lintels (cut
  // to the opening width they span, not wall height) — one pass over
  // the openings for both, so each opening's own height/double-stud
  // choice is respected rather than an aggregate wall-height count.
  for (const o of inputs.openings) {
    if ((o.width_mm ?? 0) <= 0) continue;
    const jackHeightM = (o.height_mm ?? inputs.wall_height_mm ?? 0) / MM_PER_M;
    const jackCount = o.double_stud ? 4 : 2;
    for (let i = 0; i < jackCount; i++) lengths.push(jackHeightM);
    lengths.push((o.width_mm as number) / MM_PER_M);
  }
  if (members.plate_lm > 0) lengths.push(members.plate_lm);
  if (members.noggins > 0) {
    // Noggins are short (one stud-bay wide each) — treat the whole
    // noggins total as pieces sized at one bay width, per row.
    const spacingM = (inputs.stud_spacing_mm ?? 0) / MM_PER_M;
    if (spacingM > 0) {
      for (let i = 0; i < members.noggins; i++) lengths.push(spacingM);
    }
  }

  return lengths;
}

/**
 * Full timber frame calculation: members → cut lengths → bin pack →
 * cost (if a priced material is linked). `pricePerMetre` is the linked
 * material's price already normalised to $/lm by the caller (e.g.
 * material.price directly if material.unit is a linear-metre unit) —
 * this function does no unit inference, it just multiplies.
 */
export function calculateTimberFrame(
  inputs: TimberFrameInputs,
  pricePerMetre: number | null
): TimberFrameResult {
  const members = timberFrameMembers(inputs);
  const cutLengths = timberFrameCutLengths(inputs, members);
  const binPack = binPackLengths(cutLengths);
  const cost =
    pricePerMetre !== null && pricePerMetre !== undefined
      ? roundMoney(binPack.total_lm_purchased * pricePerMetre)
      : null;
  return { members, binPack, cost };
}

// ------------------------------------------------------------
// Plasterboard calculator
//
// BUILD-SPEC.md formula: wall dims − openings → m², sheets (from
// selected sheet size), screws/adhesive note, cost via linked
// material.
// ------------------------------------------------------------

/**
 * Net wall area in m²: (length × height) − sum(opening width × opening
 * height), mm inputs. Each opening subtracts its OWN height when
 * given (7 July 2026, Phillip) — capped at the wall height so a typo'd
 * taller-than-wall value can't invert the subtraction — falling back
 * to the full wall height for an opening with no stated height, same
 * assumption this calculator always made before the height field
 * existed (the conservative direction for a "how much board do I
 * need" estimate: assuming full height very slightly UNDER-estimates
 * area needed for a window that doesn't reach the ceiling, paired with
 * the wastage the sheet rounding below naturally provides).
 */
export function netWallAreaM2(
  wallLengthMm: number,
  wallHeightMm: number,
  openings: FrameOpening[]
): number {
  if (wallLengthMm <= 0 || wallHeightMm <= 0) return 0;
  const grossM2 = (wallLengthMm / MM_PER_M) * (wallHeightMm / MM_PER_M);
  const openingsM2 = openings.reduce((sum, o) => {
    const widthMm = o.width_mm ?? 0;
    if (widthMm <= 0) return sum;
    const heightMm = Math.min(o.height_mm ?? wallHeightMm, wallHeightMm);
    return sum + (widthMm / MM_PER_M) * (heightMm / MM_PER_M);
  }, 0);
  return Math.max(0, grossM2 - openingsM2);
}

/** m² covered by a single sheet, from its mm dimensions. */
export function sheetAreaM2(sheet: SheetSizeMm): number {
  return (sheet.width / MM_PER_M) * (sheet.length / MM_PER_M);
}

/**
 * Full plasterboard calculation. Returns zeroed results when a
 * required input (wall dims, sheet size) is missing — same "no
 * defaults" rule as the timber frame calc: an unfilled sheet-size
 * select must not silently assume the first catalogue entry.
 */
export function calculatePlasterboard(
  inputs: PlasterboardInputs,
  pricePerSheet: number | null
): PlasterboardResult {
  const { wall_length_mm, wall_height_mm, openings, sheet_size_mm } = inputs;

  if (!wall_length_mm || !wall_height_mm || !sheet_size_mm) {
    return { net_area_m2: 0, sheets_required: 0, utilisation_pct: 0, cost: null };
  }

  const net_area_m2 = netWallAreaM2(wall_length_mm, wall_height_mm, openings);
  const perSheetM2 = sheetAreaM2(sheet_size_mm);
  const sheets_required = perSheetM2 > 0 ? Math.ceil(net_area_m2 / perSheetM2) : 0;
  const purchasedM2 = sheets_required * perSheetM2;
  const utilisation_pct = purchasedM2 > 0 ? net_area_m2 / purchasedM2 : 0;

  const cost =
    pricePerSheet !== null && pricePerSheet !== undefined
      ? roundMoney(sheets_required * pricePerSheet)
      : null;

  return { net_area_m2: roundMoney(net_area_m2), sheets_required, utilisation_pct, cost };
}

/**
 * Fixed note surfaced alongside the plasterboard result — BUILD-SPEC.md
 * "screws/adhesive note". Not a computed quantity (no per-m² screw/
 * adhesive rate was specified in the brief) — a plain reminder string,
 * same spirit as the "no framing defaults" rule: this calculator does
 * not invent a screws-per-sheet figure nobody asked it to compute.
 */
export const PLASTERBOARD_FIXINGS_NOTE =
  "Allow additional screws (~30/sheet) and adhesive/jointing compound — not quantified by this calculator; confirm with your plasterer's standard rate.";

// ------------------------------------------------------------
// Shared money rounding (mirrors lib/estimate.ts roundMoney() exactly
// — duplicated rather than imported so this module stays fully
// dependency-free per its header comment; both round-half-up to 2dp).
// ------------------------------------------------------------
function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

// ------------------------------------------------------------
// Provenance / description composition — "Insert as estimate line"
// ------------------------------------------------------------

/**
 * Auto-composed description + provenance note for a cost_line created
 * from a calculator result — BUILD-SPEC.md "'Insert as estimate line'
 * → creates a cost_line in a chosen section with description
 * auto-composed + provenance note (calculator + inputs summary)".
 */
export function timberFrameLineDescription(inputs: TimberFrameInputs): {
  description: string;
  provenance: string;
} {
  const profile = inputs.timber_profile.trim() || "timber frame";
  const lenM = inputs.wall_length_mm ? (inputs.wall_length_mm / MM_PER_M).toFixed(2) : "?";
  const heightM = inputs.wall_height_mm ? (inputs.wall_height_mm / MM_PER_M).toFixed(2) : "?";
  const description = `Timber frame — ${profile} — ${lenM}m × ${heightM}m`;
  const provenance = [
    "Calculator: Timber frame",
    `wall ${lenM}m × ${heightM}m`,
    inputs.stud_spacing_mm ? `studs @${inputs.stud_spacing_mm}mm` : null,
    inputs.double_top_plate ? "double top plate" : null,
    inputs.openings.length ? `${inputs.openings.length} opening(s)` : null,
    inputs.openings.some((o) => o.double_stud) ? "double-studded opening(s)" : null,
    inputs.timber_profile.trim() ? `profile ${inputs.timber_profile.trim()}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { description, provenance };
}

export function plasterboardLineDescription(inputs: PlasterboardInputs): {
  description: string;
  provenance: string;
} {
  const lenM = inputs.wall_length_mm ? (inputs.wall_length_mm / MM_PER_M).toFixed(2) : "?";
  const heightM = inputs.wall_height_mm ? (inputs.wall_height_mm / MM_PER_M).toFixed(2) : "?";
  const sheet = inputs.sheet_size_mm
    ? `${inputs.sheet_size_mm.width}×${inputs.sheet_size_mm.length}`
    : "?";
  const description = `Plasterboard — ${lenM}m × ${heightM}m wall`;
  const provenance = [
    "Calculator: Plasterboard",
    `wall ${lenM}m × ${heightM}m`,
    `sheet size ${sheet}mm`,
    inputs.openings.length ? `${inputs.openings.length} opening(s)` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { description, provenance };
}
