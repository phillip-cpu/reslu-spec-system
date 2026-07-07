"use client";

import { useMemo, useState } from "react";
import {
  calculateBrick,
  brickLineDescription,
  brickUnitRate,
  BRICK_MORTAR_NOTE,
} from "@/lib/calculators";
import type { BrickInputs, FrameOpening, Material } from "@/types/round-b";
import { MaterialLinkControl } from "./MaterialLinkControl";

interface Props {
  materials: Material[];
  onMaterialAdded: (m: Material) => void;
  onMaterialUpdated: (m: Material) => void;
  /** Insert the computed result as a new cost_line — see CalculatorsPanel's insertLine() for the actual POST. */
  onInsertLine: (input: {
    sectionId: string;
    description: string;
    notes: string;
    qty: number | null;
    unit: string | null;
    cost_ex_gst: number | null;
  }) => Promise<void>;
  sections: { id: string; name: string }[];
}

/** Default mortar joint width, mm — the one field on this calculator
 * that DOES start with a value rather than null (see BrickInputs' own
 * doc comment, types/round-b.ts, for why: 10mm is the near-universal
 * standard joint, unlike a brick's own dimensions which vary by
 * product and so start blank per this round's "no assumed spec" rule). */
const DEFAULT_MORTAR_JOINT_MM = 10;

/**
 * Brick calculator — "Two more — 7 July 2026 evening". Same "no
 * framing defaults" discipline as TimberFrameCalculator/
 * PlasterboardCalculator: brick length/height/width start null (no
 * assumed brick spec — Australian common/face/metric-modular bricks
 * are all different sizes). mortar_joint_mm starts at 10 (the standard
 * joint) but stays fully editable.
 *
 * All actual math lives in lib/calculators.ts (calculateBrick) — this
 * component is pure input-collection + result display + the "insert as
 * estimate line" action + the "Request pricing via Aria" action on the
 * linked material, mirroring the sibling calculators' own division of
 * labour.
 */
export function BrickCalculator({ materials, onMaterialAdded, onMaterialUpdated, onInsertLine, sections }: Props) {
  const [brickLengthMm, setBrickLengthMm] = useState<number | null>(null);
  const [brickHeightMm, setBrickHeightMm] = useState<number | null>(null);
  const [brickWidthMm, setBrickWidthMm] = useState<number | null>(null);
  const [mortarJointMm, setMortarJointMm] = useState<number>(DEFAULT_MORTAR_JOINT_MM);
  const [wallLengthMm, setWallLengthMm] = useState<number | null>(null);
  const [wallHeightMm, setWallHeightMm] = useState<number | null>(null);
  const [openings, setOpenings] = useState<FrameOpening[]>([]);
  const [wastagePct, setWastagePct] = useState<number | null>(null);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);
  // "Request pricing via Aria" action state — separate from
  // MaterialLinkControl's own busy/error state since this is a second,
  // calculator-specific action on the same linked material (that
  // control's "Refresh price" button requires product_url and does a
  // page scrape; this one is the no-product-page "ask a human/Aria for
  // a supplier quote" path — see app/api/materials/[id]/refresh-price/
  // route.ts's ?mode=supplier_quote doc comment).
  const [requestingQuote, setRequestingQuote] = useState(false);
  const [quoteRequestError, setQuoteRequestError] = useState<string | null>(null);

  const inputs: BrickInputs = useMemo(
    () => ({
      brick_length_mm: brickLengthMm,
      brick_height_mm: brickHeightMm,
      brick_width_mm: brickWidthMm,
      mortar_joint_mm: mortarJointMm,
      wall_length_mm: wallLengthMm,
      wall_height_mm: wallHeightMm,
      openings,
      wastage_pct: wastagePct,
    }),
    [brickLengthMm, brickHeightMm, brickWidthMm, mortarJointMm, wallLengthMm, wallHeightMm, openings, wastagePct]
  );

  const material = materials.find((m) => m.id === materialId) ?? null;
  // Unit-aware: divides by 1000 when the linked material's unit reads
  // as "per 1000"/"thousand" (bricks are commonly sold that way) — see
  // lib/calculators.ts brickUnitRate()'s doc comment for the exact
  // matching rule.
  const pricePerBrick = brickUnitRate(material?.price ?? null, material?.unit ?? null);

  const ready = Boolean(brickLengthMm && brickHeightMm && wallLengthMm && wallHeightMm);
  const result = ready ? calculateBrick(inputs, pricePerBrick) : null;

  // "Waiting for Aria" / stale-or-absent price — same read MaterialLinkControl
  // itself uses for its own badge (price_refresh_status === 'needs_aria'),
  // plus the plain "no price at all yet" case, either of which is worth
  // offering the "Request pricing via Aria" action for.
  const priceAbsentOrStale = Boolean(material) && (material!.price === null || material!.price_refresh_status === "needs_aria");

  function addOpening() {
    setOpenings((cur) => [...cur, { width_mm: null, height_mm: null, double_stud: false }]);
  }
  function updateOpening(i: number, patch: Partial<FrameOpening>) {
    setOpenings((cur) => cur.map((o, idx) => (idx === i ? { ...o, ...patch } : o)));
  }
  function removeOpening(i: number) {
    setOpenings((cur) => cur.filter((_, idx) => idx !== i));
  }

  async function insertAsLine() {
    if (!result || !sectionId) return;
    setInserting(true);
    setInsertError(null);
    try {
      const { description, provenance } = brickLineDescription(inputs);
      await onInsertLine({
        sectionId,
        description,
        notes: provenance,
        qty: result.total_bricks,
        unit: "brick",
        cost_ex_gst: result.cost,
      });
      setInserted(true);
      setTimeout(() => setInserted(false), 3000);
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : "Could not insert estimate line.");
    } finally {
      setInserting(false);
    }
  }

  /**
   * "Request pricing via Aria" — POSTs the SAME refresh-price route
   * MaterialLinkControl's own "Refresh price" button uses, just with
   * ?mode=supplier_quote so it skips the product-page scrape entirely
   * (bricks are commonly priced per-1000 via a supplier quote, not a
   * scrapable product page) and goes straight to needs_aria + the
   * distinct "Supplier quote needed" email — see that route's doc
   * comment. Once-only guard lives server-side (same
   * price_refresh_status check the scrape-failure path already uses),
   * so a repeat click here is harmless — no duplicate email.
   */
  async function requestPricingViaAria() {
    if (!material) return;
    setRequestingQuote(true);
    setQuoteRequestError(null);
    try {
      const res = await fetch(`/api/materials/${material.id}/refresh-price?mode=supplier_quote`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not request pricing.");
      if (body.material) onMaterialUpdated(body.material as Material);
    } catch (err) {
      setQuoteRequestError(err instanceof Error ? err.message : "Could not request pricing.");
    } finally {
      setRequestingQuote(false);
    }
  }

  return (
    <div className="space-y-4 border border-[#dcd6cc] bg-cream p-4">
      <p className="label-caps !text-nearblack">Brick calculator</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Brick length (mm)">
          <NumInput value={brickLengthMm} onChange={setBrickLengthMm} />
        </Field>
        <Field label="Brick height (mm)">
          <NumInput value={brickHeightMm} onChange={setBrickHeightMm} />
        </Field>
        <Field label="Brick width (mm)">
          <NumInput value={brickWidthMm} onChange={setBrickWidthMm} placeholder="optional" />
        </Field>
        <Field label="Mortar joint (mm)">
          <input
            type="number"
            step="any"
            value={mortarJointMm}
            onChange={(e) => setMortarJointMm(e.target.value === "" ? 0 : Number(e.target.value))}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </Field>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Wall length (mm)">
          <NumInput value={wallLengthMm} onChange={setWallLengthMm} />
        </Field>
        <Field label="Wall height (mm)">
          <NumInput value={wallHeightMm} onChange={setWallHeightMm} />
        </Field>
        <Field label="Wastage (%)">
          <NumInput value={wastagePct} onChange={setWastagePct} placeholder="e.g. 5" />
        </Field>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between">
          <p className="label-caps">Openings (doors / windows)</p>
          <button
            type="button"
            onClick={addOpening}
            className="text-caption text-charcoal/60 underline hover:text-nearblack"
          >
            + Add opening
          </button>
        </div>
        {openings.length === 0 ? (
          <p className="text-caption text-charcoal/50">No openings added.</p>
        ) : (
          <div className="space-y-1">
            {openings.map((o, i) => (
              <div key={i} className="flex items-center gap-2">
                <NumInput
                  value={o.width_mm}
                  onChange={(v) => updateOpening(i, { width_mm: v })}
                  placeholder="width mm"
                />
                <NumInput
                  value={o.height_mm}
                  onChange={(v) => updateOpening(i, { height_mm: v })}
                  placeholder="height mm (defaults to wall height)"
                />
                <button
                  type="button"
                  onClick={() => removeOpening(i)}
                  className="text-caption text-charcoal/40 hover:text-red-700"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      <MaterialLinkControl
        materials={materials}
        selectedId={materialId}
        onSelect={setMaterialId}
        onMaterialAdded={onMaterialAdded}
        onMaterialUpdated={onMaterialUpdated}
      />

      {/* "Request pricing via Aria" — this round's brick-specific
          action, shown only when a material IS linked and its price is
          missing or already flagged stale/needs_aria (see
          priceAbsentOrStale above). Deliberately separate from
          MaterialLinkControl's own "Waiting for Aria" caption (still
          shown by that component whenever price_refresh_status ===
          'needs_aria', regardless of which action set it) — this is
          just the button that CAN set that state via the supplier-quote
          mode, for materials that don't have a scrapable product_url. */}
      {material && priceAbsentOrStale && (
        <div className="flex flex-wrap items-center gap-2 border border-[#dcd6cc] bg-offwhite px-3 py-2">
          {material.price_refresh_status === "needs_aria" ? (
            <span className="border border-sand bg-cream px-2 py-1 text-caption !text-sand">
              Waiting for Aria
              {material.price_refresh_requested_at &&
                ` · requested ${new Date(material.price_refresh_requested_at).toLocaleDateString("en-AU")}`}
            </span>
          ) : (
            <>
              <span className="text-caption text-charcoal/60">No price on file for {material.name}.</span>
              <button
                type="button"
                disabled={requestingQuote}
                onClick={requestPricingViaAria}
                className="border border-[#c9c2b4] px-3 py-1.5 text-body text-charcoal transition-colors hover:bg-nearwhite disabled:opacity-40"
              >
                {requestingQuote ? "Requesting…" : "Request pricing via Aria"}
              </button>
            </>
          )}
          {quoteRequestError && <span className="text-caption text-red-700">{quoteRequestError}</span>}
        </div>
      )}

      {!ready ? (
        <p className="text-body text-charcoal/50">
          Fill in brick length, brick height, wall length, and wall height to see a result.
        </p>
      ) : (
        result && (
          <div className="space-y-2 border-t border-[#dcd6cc] pt-3">
            <p className="text-body text-charcoal">
              Net area: {result.net_area_m2.toFixed(2)}m² · Bricks/m²: {result.bricks_per_m2.toFixed(1)} · Total
              bricks: {result.total_bricks}
            </p>
            <p className="text-caption text-charcoal/60">
              Mortar (estimate): {result.mortar_volume_m3.toFixed(3)}m³
            </p>
            <p className="text-caption text-charcoal/60">{BRICK_MORTAR_NOTE}</p>

            <p className="text-subhead text-nearblack">
              {result.cost !== null
                ? `Cost: $${result.cost.toFixed(2)} ex GST${material ? ` (via ${material.name})` : ""}`
                : "Cost: link a priced material to see a total."}
            </p>

            <div className="flex flex-wrap items-center gap-2 border-t border-[#e5e0d6] pt-2">
              <select
                value={sectionId}
                onChange={(e) => setSectionId(e.target.value)}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              >
                <option value="">Choose a section…</option>
                {sections.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={!sectionId || inserting}
                onClick={insertAsLine}
                className="border border-nearblack bg-nearblack px-3 py-1.5 text-body text-white transition-colors hover:bg-charcoal disabled:opacity-40"
              >
                {inserting ? "Inserting…" : "Insert as estimate line"}
              </button>
              {inserted && <span className="text-caption !text-sand">Inserted.</span>}
              {insertError && <span className="text-caption text-red-700">{insertError}</span>}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="label-caps mb-1">{label}</p>
      {children}
    </div>
  );
}

function NumInput({
  value,
  onChange,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  placeholder?: string;
}) {
  return (
    <input
      type="number"
      step="any"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
    />
  );
}
