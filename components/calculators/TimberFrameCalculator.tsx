"use client";

import { useMemo, useState } from "react";
import { calculateTimberFrame, timberFrameLineDescription } from "@/lib/calculators";
import { STUD_SPACINGS } from "@/types/round-b";
import type { FrameOpening, Material, StudSpacing, TimberFrameInputs } from "@/types/round-b";
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

/**
 * Timber frame calculator — BUILD-SPEC.md "Phillip's ideas list — 6
 * July 2026" item 4(a). DECISIONS paragraph above item 5: NO framing
 * defaults — every input below starts empty/null; nothing here
 * pre-fills a "typical" stud spacing, wall height, etc. The user must
 * type/select every value themselves before a result renders.
 *
 * All actual math lives in lib/calculators.ts (calculateTimberFrame) —
 * this component is pure input-collection + result display + the
 * "insert as estimate line" action; it holds no formulas itself.
 */
export function TimberFrameCalculator({
  materials,
  onMaterialAdded,
  onMaterialUpdated,
  onInsertLine,
  sections,
}: Props) {
  // No defaults anywhere below — every numeric field starts null, every
  // select starts unselected, the openings list starts empty, and the
  // toggle starts false (an explicit, deliberate choice, not "empty" in
  // the same sense as the null fields, but still not assuming the more
  // common "single top plate" — see BUILD-SPEC.md's read of this
  // exact toggle name below).
  const [wallLengthMm, setWallLengthMm] = useState<number | null>(null);
  const [wallHeightMm, setWallHeightMm] = useState<number | null>(null);
  const [studSpacing, setStudSpacing] = useState<StudSpacing | null>(null);
  const [doubleTopPlate, setDoubleTopPlate] = useState(false);
  const [openings, setOpenings] = useState<FrameOpening[]>([]);
  const [timberProfile, setTimberProfile] = useState("");
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);

  const inputs: TimberFrameInputs = useMemo(
    () => ({
      wall_length_mm: wallLengthMm,
      wall_height_mm: wallHeightMm,
      stud_spacing_mm: studSpacing,
      double_top_plate: doubleTopPlate,
      openings,
      timber_profile: timberProfile,
    }),
    [wallLengthMm, wallHeightMm, studSpacing, doubleTopPlate, openings, timberProfile]
  );

  const material = materials.find((m) => m.id === materialId) ?? null;
  // Material price is assumed $/lm for this calculator — no unit
  // inference is attempted (see lib/calculators.ts calculateTimberFrame
  // doc comment); if the linked material's `unit` isn't a linear-metre
  // unit, the cost figure will be misleading, so the caption below
  // surfaces the material's own unit next to the cost so a mismatch is
  // visible at a glance rather than silently wrong.
  const pricePerMetre = material?.price ?? null;

  const ready = Boolean(wallLengthMm && wallHeightMm && studSpacing);
  const result = ready ? calculateTimberFrame(inputs, pricePerMetre) : null;

  function addOpening() {
    setOpenings((cur) => [...cur, { width_mm: null }]);
  }
  function updateOpening(i: number, width_mm: number | null) {
    setOpenings((cur) => cur.map((o, idx) => (idx === i ? { width_mm } : o)));
  }
  function removeOpening(i: number) {
    setOpenings((cur) => cur.filter((_, idx) => idx !== i));
  }

  async function insertAsLine() {
    if (!result || !sectionId) return;
    setInserting(true);
    setInsertError(null);
    try {
      const { description, provenance } = timberFrameLineDescription(inputs);
      await onInsertLine({
        sectionId,
        description,
        notes: provenance,
        qty: result.binPack.total_lm_purchased,
        unit: "lm",
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

  return (
    <div className="space-y-4 border border-[#dcd6cc] bg-cream p-4">
      <p className="label-caps !text-nearblack">Timber frame calculator</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="Wall length (mm)">
          <NumInput value={wallLengthMm} onChange={setWallLengthMm} />
        </Field>
        <Field label="Wall height (mm)">
          <NumInput value={wallHeightMm} onChange={setWallHeightMm} />
        </Field>
        <Field label="Stud spacing">
          <select
            value={studSpacing ?? ""}
            onChange={(e) => setStudSpacing(e.target.value ? (Number(e.target.value) as StudSpacing) : null)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="">Select…</option>
            {STUD_SPACINGS.map((s) => (
              <option key={s} value={s}>
                {s}mm
              </option>
            ))}
          </select>
        </Field>
        <Field label="Timber profile">
          <input
            value={timberProfile}
            onChange={(e) => setTimberProfile(e.target.value)}
            placeholder="e.g. 90x45 MGP10"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 text-body text-charcoal">
        <input
          type="checkbox"
          checked={doubleTopPlate}
          onChange={(e) => setDoubleTopPlate(e.target.checked)}
        />
        Double top plate
      </label>

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
                  onChange={(v) => updateOpening(i, v)}
                  placeholder="width mm"
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

      {!ready ? (
        <p className="text-body text-charcoal/50">
          Fill in wall length, wall height, and stud spacing to see a result.
        </p>
      ) : (
        result && (
          <div className="space-y-2 border-t border-[#dcd6cc] pt-3">
            <p className="label-caps !text-sand">Members</p>
            <ul className="grid grid-cols-2 gap-x-6 gap-y-1 text-body text-charcoal md:grid-cols-3">
              <li>Studs: {result.members.studs}</li>
              <li>Plate (lm): {result.members.plate_lm.toFixed(2)}</li>
              <li>Jack studs: {result.members.jack_studs}</li>
              <li>Lintels: {result.members.lintels}</li>
              <li>Noggin rows: {result.members.noggin_rows}</li>
              <li>Noggins: {result.members.noggins}</li>
            </ul>

            <p className="label-caps !text-sand">Bin-packed purchase list</p>
            <p className="text-body text-charcoal">
              {result.binPack.lengths_to_buy.length > 0
                ? result.binPack.lengths_to_buy.map((l) => `${l}m`).join(", ")
                : "—"}
            </p>
            <p className="text-caption text-charcoal/60">
              Total purchased: {result.binPack.total_lm_purchased.toFixed(2)}lm · Required:{" "}
              {result.binPack.total_lm_required.toFixed(2)}lm · Waste:{" "}
              {(result.binPack.waste_pct * 100).toFixed(1)}%
            </p>

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
