"use client";

import { useMemo, useState } from "react";
import {
  calculatePlasterboard,
  plasterboardLineDescription,
  PLASTERBOARD_FIXINGS_NOTE,
} from "@/lib/calculators";
import { SHEET_SIZES_MM } from "@/types/round-b";
import type { FrameOpening, Material, PlasterboardInputs, SheetSizeMm } from "@/types/round-b";
import { MaterialLinkControl } from "./MaterialLinkControl";

interface Props {
  materials: Material[];
  onMaterialAdded: (m: Material) => void;
  onMaterialUpdated: (m: Material) => void;
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

function sheetKey(s: SheetSizeMm): string {
  return `${s.width}x${s.length}`;
}

/**
 * Plasterboard calculator — BUILD-SPEC.md "Phillip's ideas list — 6
 * July 2026" item 4(b). Same "no framing defaults" rule as the timber
 * frame calc: sheet_size_mm starts unselected, not defaulted to the
 * first catalogue entry.
 */
export function PlasterboardCalculator({
  materials,
  onMaterialAdded,
  onMaterialUpdated,
  onInsertLine,
  sections,
}: Props) {
  const [wallLengthMm, setWallLengthMm] = useState<number | null>(null);
  const [wallHeightMm, setWallHeightMm] = useState<number | null>(null);
  const [openings, setOpenings] = useState<FrameOpening[]>([]);
  const [sheetSize, setSheetSize] = useState<SheetSizeMm | null>(null);
  const [materialId, setMaterialId] = useState<string | null>(null);
  const [sectionId, setSectionId] = useState<string>("");
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);
  const [inserted, setInserted] = useState(false);

  const inputs: PlasterboardInputs = useMemo(
    () => ({
      wall_length_mm: wallLengthMm,
      wall_height_mm: wallHeightMm,
      openings,
      sheet_size_mm: sheetSize,
    }),
    [wallLengthMm, wallHeightMm, openings, sheetSize]
  );

  const material = materials.find((m) => m.id === materialId) ?? null;
  // Assumed $/sheet, same "no unit inference" caveat as the timber
  // frame calculator's $/lm assumption — see lib/calculators.ts
  // calculatePlasterboard's caller-supplied pricePerSheet doc comment.
  const pricePerSheet = material?.price ?? null;

  const ready = Boolean(wallLengthMm && wallHeightMm && sheetSize);
  const result = ready ? calculatePlasterboard(inputs, pricePerSheet) : null;

  function addOpening() {
    // double_stud is meaningless for board area — always false here,
    // never surfaced in this calculator's UI (see FrameOpening's doc
    // comment).
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
      const { description, provenance } = plasterboardLineDescription(inputs);
      await onInsertLine({
        sectionId,
        description,
        notes: provenance,
        qty: result.sheets_required,
        unit: "sheet",
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
      <p className="label-caps !text-nearblack">Plasterboard calculator</p>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Wall length (mm)">
          <NumInput value={wallLengthMm} onChange={setWallLengthMm} />
        </Field>
        <Field label="Wall height (mm)">
          <NumInput value={wallHeightMm} onChange={setWallHeightMm} />
        </Field>
        <Field label="Sheet size">
          <select
            value={sheetSize ? sheetKey(sheetSize) : ""}
            onChange={(e) => {
              const found = SHEET_SIZES_MM.find((s) => sheetKey(s) === e.target.value);
              setSheetSize(found ?? null);
            }}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="">Select…</option>
            {SHEET_SIZES_MM.map((s) => (
              <option key={sheetKey(s)} value={sheetKey(s)}>
                {s.width}×{s.length}mm
              </option>
            ))}
          </select>
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

      {!ready ? (
        <p className="text-body text-charcoal/50">
          Fill in wall length, wall height, and sheet size to see a result.
        </p>
      ) : (
        result && (
          <div className="space-y-2 border-t border-[#dcd6cc] pt-3">
            <p className="text-body text-charcoal">
              Net area: {result.net_area_m2.toFixed(2)}m² · Sheets required:{" "}
              {result.sheets_required} · Utilisation: {(result.utilisation_pct * 100).toFixed(1)}%
            </p>
            <p className="text-caption text-charcoal/60">{PLASTERBOARD_FIXINGS_NOTE}</p>
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
