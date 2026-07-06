"use client";

import { useState } from "react";
import type { Material } from "@/types/round-b";

interface Props {
  materials: Material[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Called after a successful inline "add material" POST so the parent's materials list can be updated in place. */
  onMaterialAdded: (material: Material) => void;
  /** Called after a successful refresh-price POST so the parent's materials list picks up the new price/timestamp. */
  onMaterialUpdated: (material: Material) => void;
}

/**
 * Round B — "Link material" select + inline add + "Refresh price"
 * button, shared by both TimberFrameCalculator and
 * PlasterboardCalculator (BUILD-SPEC.md "Phillip's ideas list — 6 July
 * 2026" item 4: "Both calcs: 'Link material' select from materials
 * table (+ inline add material with product_url); 'Refresh price'
 * button").
 *
 * Deliberately dumb/presentational: all network calls live here (this
 * is the one component that talks to /api/materials/**), but the
 * *materials list itself* is owned by the parent CalculatorsPanel (one
 * shared fetch for both calculators, rather than each calculator
 * re-fetching the same global list) — this component only ever mutates
 * that list via the two callback props, never holds its own copy.
 */
export function MaterialLinkControl({
  materials,
  selectedId,
  onSelect,
  onMaterialAdded,
  onMaterialUpdated,
}: Props) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshNote, setRefreshNote] = useState<string | null>(null);

  const selected = materials.find((m) => m.id === selectedId) ?? null;

  async function addMaterial() {
    if (!newName.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newName.trim(), product_url: newUrl.trim() || undefined }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not add material.");
      }
      const { material } = await res.json();
      onMaterialAdded(material as Material);
      onSelect((material as Material).id);
      setAdding(false);
      setNewName("");
      setNewUrl("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add material.");
    } finally {
      setBusy(false);
    }
  }

  async function refreshPrice() {
    if (!selected) return;
    setBusy(true);
    setError(null);
    setRefreshNote(null);
    try {
      const res = await fetch(`/api/materials/${selected.id}/refresh-price`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error ?? "Could not refresh price.");
      }
      if (body.material) onMaterialUpdated(body.material as Material);
      // "failures flag, never block" — a failed refresh (ok: false) is
      // NOT thrown as an error; it's surfaced as an inline caption only.
      setRefreshNote(body.ok ? "Price refreshed." : (body.note ?? "Could not find a price on the page."));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not refresh price.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 border border-[#dcd6cc] bg-offwhite p-3">
      <p className="label-caps">Link material</p>

      {error && <p className="text-caption text-red-700">{error}</p>}

      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedId ?? ""}
          onChange={(e) => onSelect(e.target.value || null)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        >
          <option value="">No material linked</option>
          {materials.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} {m.price !== null ? `— $${m.price.toFixed(2)}/${m.unit}` : "(no price)"}
            </option>
          ))}
        </select>

        {selected && (
          <button
            type="button"
            disabled={busy || !selected.product_url}
            title={selected.product_url ? "Refresh price from product_url" : "No product_url set on this material"}
            onClick={refreshPrice}
            className="border border-[#c9c2b4] px-3 py-1.5 text-body text-charcoal transition-colors hover:bg-nearwhite disabled:opacity-40"
          >
            Refresh price
          </button>
        )}

        <button
          type="button"
          onClick={() => setAdding((v) => !v)}
          className="text-caption text-charcoal/60 underline hover:text-nearblack"
        >
          {adding ? "Cancel" : "+ Add material"}
        </button>
      </div>

      {refreshNote && <p className="text-caption text-charcoal/60">{refreshNote}</p>}

      {selected && (
        <p className="text-caption text-charcoal/50">
          {selected.price !== null ? `$${selected.price.toFixed(2)} / ${selected.unit}` : "No price yet"}
          {selected.price_refreshed_at &&
            ` · refreshed ${new Date(selected.price_refreshed_at).toLocaleDateString("en-AU")}`}
          {selected.coverage_per_unit ? ` · covers ${selected.coverage_per_unit} per unit` : ""}
        </p>
      )}

      {adding && (
        <div className="flex flex-wrap items-end gap-2 border-t border-[#e5e0d6] pt-2">
          <div>
            <p className="label-caps mb-1">Name</p>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. 90x45 MGP10 pine"
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
          </div>
          <div>
            <p className="label-caps mb-1">Product URL (optional)</p>
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://…"
              className="w-64 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
            />
          </div>
          <button
            type="button"
            disabled={busy || !newName.trim()}
            onClick={addMaterial}
            className="border border-nearblack bg-nearblack px-3 py-1.5 text-body text-white transition-colors hover:bg-charcoal disabled:opacity-40"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
