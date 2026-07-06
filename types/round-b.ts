// ============================================================
// RESLU Spec System — Round B LOCAL types (6 July 2026)
// Takeoff → FF&E quantity links (items.measurement_id/wastage_pct/
// coverage_per_unit — migration 027) + materials price list +
// calculators (timber frame / plasterboard).
//
// Same isolation convention every phase-N.ts / phase-small-round.ts
// file in this directory already follows (see phase-small-round.ts's
// own header comment for the full rationale): types/index.ts is a
// protected file for this round (per the task brief's DO-NOT-TOUCH
// list), so any shape needed only by this round's own files lives
// here instead and is imported directly from this module rather than
// added to the shared file.
// ============================================================

import type { Item, Measurement } from "@/types";

// ------------------------------------------------------------
// Materials — supabase/migrations/027_quantity_links_materials.sql
// ------------------------------------------------------------

export interface Material {
  id: string;
  name: string;
  product_url: string | null;
  unit: string;
  price: number | null;
  price_refreshed_at: string | null;
  coverage_per_unit: number | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface MaterialsListResponse {
  materials: Material[];
}

export interface MaterialResponse {
  material: Material;
}

/** Body accepted by POST /api/materials. name is the only required field. */
export interface CreateMaterialInput {
  name: string;
  product_url?: string | null;
  unit?: string;
  price?: number | null;
  coverage_per_unit?: number | null;
  notes?: string | null;
}

/** Body accepted by PATCH /api/materials/[id] — same whitelist shape as items' EDITABLE_FIELDS. */
export interface PatchMaterialInput {
  name?: string;
  product_url?: string | null;
  unit?: string;
  price?: number | null;
  coverage_per_unit?: number | null;
  notes?: string | null;
}

/** Response from POST /api/materials/[id]/refresh-price. Never a hard failure — see that route's doc comment. */
export interface RefreshPriceResponse {
  material: Material;
  ok: boolean;
  note?: string;
}

// ------------------------------------------------------------
// Items gain a measurement link (mirrors cost_lines.measurement_id +
// lib/estimate.ts's effectiveQty()/EffectiveQtyMeasurementInput shape)
// — see lib/item-quantity.ts derivedQuantity() for the read-side math.
// ------------------------------------------------------------

/** The three new items columns from migration 027, as a standalone patchable shape (Item itself is defined in the protected types/index.ts and is NOT extended here — API routes merge these fields onto the existing Item response object at runtime instead of this type literally extending Item). */
export interface ItemQuantityLinkFields {
  measurement_id: string | null;
  wastage_pct: number | null;
  coverage_per_unit: number | null;
}

/** Body accepted by PATCH /api/items/[id] for the new quantity-link fields — same route, just three more whitelisted keys (see that route's EDITABLE_FIELDS doc comment for the Round B addition note). */
export interface PatchItemQuantityLinkInput {
  measurement_id?: string | null;
  wastage_pct?: number | null;
  coverage_per_unit?: number | null;
}

/**
 * An Item as returned by GET /api/items/[id] or GET
 * /api/projects/[id]/items once Round B's join is applied: carries the
 * plain Item fields (including the new measurement_id/wastage_pct/
 * coverage_per_unit columns, already present on the raw `items` row
 * and thus on `Item` via `select("*")`/the explicit column list) PLUS
 * the linked measurement's value/unit/label when measurement_id is
 * set, so the UI never needs a second round-trip to show "linked ·
 * 12.4 m² · +10%".
 */
export interface ItemWithLinkedMeasurement extends Item {
  linked_measurement: Pick<Measurement, "id" | "label" | "value" | "unit"> | null;
}

// ------------------------------------------------------------
// Calculators — lib/calculators.ts pure math + component input shapes.
// BUILD-SPEC.md "Phillip's ideas list — 6 July 2026" item 4. DECISIONS
// paragraph above item 5: NO framing defaults — every field below
// starts as `null`/empty in the UI; nothing in this file supplies a
// fallback/default value for a calculator input.
// ------------------------------------------------------------

export const STUD_SPACINGS = [450, 600] as const;
export type StudSpacing = (typeof STUD_SPACINGS)[number];

/** Standard Australian timber stock lengths (metres) — lib/calculators.ts binPackLengths() bin-packs onto this list. */
export const STOCK_LENGTHS_M = [2.4, 2.7, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0] as const;

/** Standard plasterboard sheet sizes (mm), width × length. */
export const SHEET_SIZES_MM = [
  { width: 1200, length: 2400 },
  { width: 1200, length: 2700 },
  { width: 1200, length: 3000 },
  { width: 1200, length: 3600 },
] as const;
export type SheetSizeMm = (typeof SHEET_SIZES_MM)[number];

/** One opening (door/window) in a wall run — width only, per BUILD-SPEC.md's "openings list (width each)". */
export interface FrameOpening {
  /** mm. */
  width_mm: number | null;
}

/**
 * Timber frame calculator inputs. Every field starts null/empty in the
 * UI (Phillip's 6 July DECISIONS: no framing defaults) — this
 * interface uses `| null` throughout rather than a numeric default so
 * an unfilled form can never silently compute against a phantom 0 or
 * a "typical" value the user never chose.
 */
export interface TimberFrameInputs {
  wall_length_mm: number | null;
  wall_height_mm: number | null;
  stud_spacing_mm: StudSpacing | null;
  double_top_plate: boolean;
  openings: FrameOpening[];
  /** Free text, e.g. "90x45 MGP10" — BUILD-SPEC.md "timber profile free text". */
  timber_profile: string;
}

export interface TimberFrameMemberList {
  studs: number;
  /** Total linear metres of top/bottom plate (single or double top plate, per input). */
  plate_lm: number;
  /** One lintel + two jack studs per opening. */
  jack_studs: number;
  lintels: number;
  /** Noggin rows × studs-per-row worth of noggin pieces (see lib/calculators.ts for the exact derivation). */
  noggin_rows: number;
  noggins: number;
}

export interface BinPackResult {
  /** Stock lengths (m) to buy, one entry per piece purchased (duplicates listed individually, e.g. [2.4, 2.4, 3.6]). */
  lengths_to_buy: number[];
  /** Sum of lengths_to_buy. */
  total_lm_purchased: number;
  /** Sum of the actual member cut lengths that were requested (before bin-packing offcut). */
  total_lm_required: number;
  /** (purchased − required) / purchased, 0–1. */
  waste_pct: number;
}

export interface TimberFrameResult {
  members: TimberFrameMemberList;
  binPack: BinPackResult;
  /** Cost of lengths_to_buy × linked material's price-per-metre, or null if no material linked/priced. */
  cost: number | null;
}

/**
 * Plasterboard calculator inputs. Same "no defaults" rule as the
 * timber frame calc — sheet_size_mm starts null, not the first array
 * entry.
 */
export interface PlasterboardInputs {
  wall_length_mm: number | null;
  wall_height_mm: number | null;
  openings: FrameOpening[];
  sheet_size_mm: SheetSizeMm | null;
}

export interface PlasterboardResult {
  /** Wall area minus openings, m². */
  net_area_m2: number;
  sheets_required: number;
  /** net_area_m2 / (sheets_required × one sheet's m²) — 0–1, how much of the purchased board is actually used. */
  utilisation_pct: number;
  /** Cost of sheets_required × linked material's per-sheet price, or null if no material linked/priced. */
  cost: number | null;
}

/** Which calculator produced a given "insert as estimate line" call — feeds the auto-composed provenance note. */
export type CalculatorKind = "timber_frame" | "plasterboard";
