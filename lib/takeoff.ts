// ============================================================
// RESLU Spec System — Aria plan analysis cross-reference engine +
// takeoff assist.
// BUILD-SPEC.md "SOW completion + Aria plan analysis" (cross-reference
// engine) and "Aria takeoff assist" (deterministic quantity takeoff).
//
// Both halves are pure, dependency-free functions (no Supabase/Next
// imports) — the API route (app/api/projects/[id]/plan-analysis/**)
// fetches rows and passes plain data in; this module never guesses or
// calls any external model itself. Aria (or a human) supplies the
// extracted rooms/item_codes/dimensions; everything downstream of that
// is deterministic arithmetic, per the build spec's explicit
// requirement: "NEVER scale-measure off the drawing (unreliable);
// anything unannotated is flagged, not guessed."
// ============================================================

import { roundMoney } from "./estimate";
import type { PlanAnalysisRoomDimensions, PlanDiscrepancy } from "@/types/phase-12a-a";

// ------------------------------------------------------------
// Cross-reference engine
// BUILD-SPEC.md: "plans-vs-FF&E in both directions — codes on plans
// missing from register, register items never placed on plans, rooms
// on plans with no FF&E items, register locations not matching plan
// room names."
// ------------------------------------------------------------

export interface CrossReferenceInput {
  /** Room names Aria found on the plan set. */
  planRooms: string[];
  /** Item codes Aria found referenced on the plan set. */
  planItemCodes: string[];
  /** Every non-deleted item's code + location for this project (register side). */
  registerItems: { item_code: string; location: string | null }[];
  /** Every non-deleted room name for this project (the `rooms` table — the CURRENT rooms schema, not items.location). */
  projectRooms: string[];
}

/**
 * Deterministic four-way cross-reference between what's on the plan
 * set and what's in the spec register. Case-insensitive, trimmed
 * matching throughout (plan annotations and register data are hand-
 * typed by different people at different times — exact-case matching
 * would produce false positives on trivial casing differences).
 */
export function crossReferencePlans(input: CrossReferenceInput): PlanDiscrepancy[] {
  const discrepancies: PlanDiscrepancy[] = [];

  const normalise = (s: string) => s.trim().toLowerCase();

  const registerCodes = new Set(input.registerItems.map((i) => normalise(i.item_code)));
  const planCodes = new Set(input.planItemCodes.map(normalise));

  // 1. Codes on plans missing from the register.
  const missingFromRegister = input.planItemCodes.filter((c) => !registerCodes.has(normalise(c)));
  if (missingFromRegister.length > 0) {
    discrepancies.push({
      kind: "code_missing_from_register",
      message: `Plans reference ${missingFromRegister.length} item code${missingFromRegister.length === 1 ? "" : "s"} not found in the register: ${missingFromRegister.join(", ")}.`,
      item_codes: missingFromRegister,
    });
  }

  // 2. Register items never placed on the plans.
  const neverOnPlan = input.registerItems
    .map((i) => i.item_code)
    .filter((code) => !planCodes.has(normalise(code)));
  if (neverOnPlan.length > 0) {
    discrepancies.push({
      kind: "register_item_not_on_plan",
      message: `${neverOnPlan.length} register item${neverOnPlan.length === 1 ? "" : "s"} not referenced anywhere on the plan set: ${neverOnPlan.join(", ")}.`,
      item_codes: neverOnPlan,
    });
  }

  // 3. Rooms on the plans with no FF&E items assigned to a
  // register location of the same name (fuzzy: exact normalised match
  // only — a genuinely different name is exactly what #4 below is for).
  const registerLocations = new Set(
    input.registerItems
      .map((i) => i.location?.trim())
      .filter((v): v is string => !!v)
      .map(normalise)
  );
  const roomsWithNoItems = input.planRooms.filter((r) => !registerLocations.has(normalise(r)));
  if (roomsWithNoItems.length > 0) {
    discrepancies.push({
      kind: "room_with_no_ffe_items",
      message: `Plans show room${roomsWithNoItems.length === 1 ? "" : "s"} with no matching FF&E items in the register: ${roomsWithNoItems.join(", ")}.`,
      room_names: roomsWithNoItems,
    });
  }

  // 4. Register locations that don't match ANY plan room name or
  // project room name — likely a naming mismatch (e.g. plans say "T3"
  // reference "SS-01/SS-02", register has "ST-01/ST-02" as a location
  // typo) rather than a genuinely unbuilt room. Compared against BOTH
  // plan room names and the project's own `rooms` table (the current
  // rooms schema) since a location might legitimately match a room
  // that simply wasn't annotated on this particular plan sheet.
  const knownRoomNames = new Set([
    ...input.planRooms.map(normalise),
    ...input.projectRooms.map(normalise),
  ]);
  const unmatchedLocations = [...registerLocations].filter((loc) => !knownRoomNames.has(loc));
  if (unmatchedLocations.length > 0) {
    // Report using the ORIGINAL casing from the register items, not the
    // normalised lookup key, so the discrepancy reads naturally.
    const originalCasing = unmatchedLocations
      .map((normalised) =>
        input.registerItems.find((i) => i.location && normalise(i.location) === normalised)?.location
      )
      .filter((v): v is string => !!v);
    discrepancies.push({
      kind: "location_name_mismatch",
      message: `Register location${originalCasing.length === 1 ? "" : "s"} not matching any plan or project room name: ${originalCasing.join(", ")}.`,
      room_names: originalCasing,
    });
  }

  return discrepancies;
}

// ------------------------------------------------------------
// Takeoff assist — deterministic quantity computation from stated
// dimensions only. BUILD-SPEC.md "Aria takeoff assist": "floor m²
// (stated dims), painting m² (perimeter × ceiling height − standard
// opening allowances, allowances configurable), tiling m² (wet-area
// conventions: floor + walls to stated heights)."
// ------------------------------------------------------------

/** Default ceiling height (metres) assumed when a room's stated dimensions omit height_m. */
export const DEFAULT_CEILING_HEIGHT_M = 2.4;

/** Standard opening allowance deducted from painting wall area per opening (door/window), m² — configurable per call. */
export const DEFAULT_OPENING_ALLOWANCE_M2 = 1.8;

export interface TakeoffResult {
  room_name: string;
  /** Floor area, m² — length × width. Null if length/width weren't both stated. */
  floor_m2: number | null;
  /** Painting area, m² — perimeter × height, less opening allowances. Null if length/width weren't both stated. */
  painting_m2: number | null;
  /** Tiling area, m² — wet areas only: floor + all four walls to stated (or default) height. Null for non-wet-area rooms or missing dims. */
  tiling_m2: number | null;
  /** True when this room had no stated dimensions at all — the room is flagged, not guessed, per the build spec. */
  unannotated: boolean;
  /** BUILD-SPEC.md's exact two provenance phrasings. */
  provenance_note: string;
}

/**
 * Computes draft takeoff quantities for one room's stated dimensions.
 * Every formula is plain arithmetic over exactly what was annotated —
 * nothing here ever infers a dimension from a drawing scale. A room
 * with no length/width at all returns nulls for every quantity and
 * `unannotated: true`, so the caller writes NO measurement row for it
 * (or writes a placeholder explicitly flagged for site measure) rather
 * than fabricating a number.
 */
export function computeRoomTakeoff(
  dims: PlanAnalysisRoomDimensions,
  openingAllowanceM2: number = DEFAULT_OPENING_ALLOWANCE_M2
): TakeoffResult {
  const { room_name, length_m, width_m, height_m, opening_count, wet_area } = dims;

  if (length_m == null || width_m == null) {
    return {
      room_name,
      floor_m2: null,
      painting_m2: null,
      tiling_m2: null,
      unannotated: true,
      provenance_note: "no stated dimension — measure on site",
    };
  }

  const height = height_m ?? DEFAULT_CEILING_HEIGHT_M;
  const floorM2 = roundMoney(length_m * width_m);
  const perimeter = 2 * (length_m + width_m);
  const openings = opening_count ?? 0;
  const paintingM2 = roundMoney(Math.max(0, perimeter * height - openings * openingAllowanceM2));

  // Wet-area tiling convention: floor + all four walls to the stated
  // (or default) height — a conservative full-height convention rather
  // than a half-height "tiled dado" assumption, matching both source
  // SOWs' "full-height waterproofing/tiling to all shower walls"
  // wording (Goldsworthy v42 / Alley v6 wet-area sections).
  const tilingM2 = wet_area ? roundMoney(floorM2 + perimeter * height) : null;

  return {
    room_name,
    floor_m2: floorM2,
    painting_m2: paintingM2,
    tiling_m2: tilingM2,
    unannotated: false,
    provenance_note: "derived from stated dimensions — verify",
  };
}

/** Runs computeRoomTakeoff over every room an analysis submitted dimensions for. */
export function computeTakeoffs(
  dimensions: PlanAnalysisRoomDimensions[],
  openingAllowanceM2: number = DEFAULT_OPENING_ALLOWANCE_M2
): TakeoffResult[] {
  return dimensions.map((d) => computeRoomTakeoff(d, openingAllowanceM2));
}
