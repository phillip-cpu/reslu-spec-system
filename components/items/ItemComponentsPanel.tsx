"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import type { Item, LibraryItem } from "@/types";
import type {
  CreateItemComponentInput,
  ItemComponent,
  ItemComponentMutationResponse,
  PatchItemComponentInput,
} from "@/types/item-components";
import {
  assemblyProcurementLabel,
  assemblyProcurementStatus,
  assemblyUnitCost,
} from "@/lib/item-components";

const aud = new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" });
const inputClass =
  "w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none";

interface Props {
  item: Item;
  components: ItemComponent[];
  onChange: (components: ItemComponent[], parentPriceTrade: number | null) => void;
  onError: (message: string | null) => void;
}

export function ItemComponentsPanel({ item, components, onChange, onError }: Props) {
  const [adding, setAdding] = useState(false);
  const [search, setSearch] = useState("");
  const [libraryResults, setLibraryResults] = useState<LibraryItem[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    supplier_item_code: "",
    supplier: "",
    finish: "",
    quantity_per_item: "1",
    unit: "ea",
    price_trade: "",
    lead_time_weeks: "",
  });

  useEffect(() => {
    if (!adding || !search.trim()) {
      setLibraryResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setLibraryLoading(true);
      fetch(`/api/library?q=${encodeURIComponent(search.trim())}&limit=30`, {
        signal: controller.signal,
      })
        .then((response) => (response.ok ? response.json() : { items: [] }))
        .then((body) => setLibraryResults(body.items ?? []))
        .catch(() => {})
        .finally(() => setLibraryLoading(false));
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [adding, search]);

  const unitCost = useMemo(() => assemblyUnitCost(components), [components]);
  const procurementStatus = assemblyProcurementStatus(components);
  const requiredQuantity = (component: ItemComponent) =>
    Number((item.quantity * component.quantity_per_item).toFixed(3));

  async function createComponent(input: CreateItemComponentInput) {
    setSaving("new");
    onError(null);
    try {
      const response = await fetch(`/api/items/${item.id}/components`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const body = (await response.json()) as ItemComponentMutationResponse & { error?: string };
      if (!response.ok || !body.component) {
        throw new Error(body.error ?? "Could not add the component");
      }
      onChange([...components, body.component], body.parent_price_trade);
      setForm({
        name: "",
        supplier_item_code: "",
        supplier: "",
        finish: "",
        quantity_per_item: "1",
        unit: "ea",
        price_trade: "",
        lead_time_weeks: "",
      });
      setSearch("");
      setLibraryResults([]);
      setAdding(false);
      setTemplateMessage(null);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not add the component");
    } finally {
      setSaving(null);
    }
  }

  async function patchComponent(id: string, patch: PatchItemComponentInput) {
    const previous = components;
    onError(null);
    setSaving(id);
    onChange(
      components.map((component) =>
        component.id === id ? ({ ...component, ...patch } as ItemComponent) : component
      ),
      item.price_trade
    );
    try {
      const response = await fetch(`/api/item-components/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = (await response.json()) as ItemComponentMutationResponse & { error?: string };
      if (!response.ok || !body.component) {
        throw new Error(body.error ?? "Could not update the component");
      }
      onChange(
        previous.map((component) => (component.id === id ? body.component! : component)),
        body.parent_price_trade
      );
      setTemplateMessage(null);
    } catch (error) {
      onChange(previous, item.price_trade);
      onError(error instanceof Error ? error.message : "Could not update the component");
    } finally {
      setSaving(null);
    }
  }

  async function deleteComponent(component: ItemComponent) {
    if (!confirm(`Remove "${component.name}" from this assembly?`)) return;
    const previous = components;
    onChange(
      components.filter((candidate) => candidate.id !== component.id),
      item.price_trade
    );
    onError(null);
    try {
      const response = await fetch(`/api/item-components/${component.id}`, { method: "DELETE" });
      const body = (await response.json()) as { parent_price_trade?: number | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not remove the component");
      onChange(
        previous.filter((candidate) => candidate.id !== component.id),
        body.parent_price_trade ?? null
      );
      setTemplateMessage(null);
    } catch (error) {
      onChange(previous, item.price_trade);
      onError(error instanceof Error ? error.message : "Could not remove the component");
    }
  }

  async function saveTemplate() {
    setSaving("template");
    onError(null);
    setTemplateMessage(null);
    try {
      const response = await fetch(`/api/items/${item.id}/components/save-template`, {
        method: "POST",
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not save the assembly");
      setTemplateMessage(
        `Reusable assembly saved with ${body.component_count} component${
          body.component_count === 1 ? "" : "s"
        }.`
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not save the assembly");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-nearblack">Item components</p>
          <p className="mt-1 text-body text-charcoal/60">
            {components.length
              ? `${components.length} part${components.length === 1 ? "" : "s"} make one ${item.name}.`
              : `Add the separate purchasable parts that make one ${item.name}.`}
          </p>
        </div>
        <div className="text-right">
          <p className="text-subhead text-nearblack">
            {unitCost === null ? "Incomplete pricing" : `${aud.format(unitCost)} per assembly`}
          </p>
          {components.length > 0 && (
            <p
              className={clsx(
                "mt-1 text-caption",
                procurementStatus === "delivered" || procurementStatus === "ordered"
                  ? "text-[#46604a]"
                  : procurementStatus.startsWith("partially")
                    ? "text-sand"
                    : "text-charcoal/50"
              )}
            >
              {assemblyProcurementLabel(components)}
            </p>
          )}
        </div>
      </div>

      {components.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] border-collapse">
            <thead>
              <tr className="border-b border-[#dcd6cc] text-left">
                <th className="label-caps px-2 py-1.5">Part</th>
                <th className="label-caps px-2 py-1.5">SKU</th>
                <th className="label-caps px-2 py-1.5">Supplier</th>
                <th className="label-caps px-2 py-1.5">Finish</th>
                <th className="label-caps px-2 py-1.5 text-right">Per item</th>
                <th className="label-caps px-2 py-1.5 text-right">Project needs</th>
                <th className="label-caps px-2 py-1.5 text-right">Unit cost</th>
                <th className="label-caps px-2 py-1.5 text-right">Part cost</th>
                <th className="label-caps px-2 py-1.5">Lead wks</th>
                <th className="label-caps px-2 py-1.5">Ordered</th>
                <th className="label-caps px-2 py-1.5">ETA</th>
                <th className="label-caps px-2 py-1.5">Delivered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {components.map((component) => (
                <tr key={component.id} className="border-b border-[#e5e0d6] align-top">
                  <td className="min-w-[180px] px-2 py-2">
                    <BlurText
                      value={component.name}
                      onCommit={(value) => patchComponent(component.id, { name: value })}
                    />
                    {component.library_item_id && (
                      <p className="mt-1 text-caption text-[#46604a]">Linked to library</p>
                    )}
                  </td>
                  <td className="w-32 px-2 py-2">
                    <BlurText
                      value={component.supplier_item_code ?? ""}
                      onCommit={(value) =>
                        patchComponent(component.id, { supplier_item_code: value || null })
                      }
                    />
                  </td>
                  <td className="w-40 px-2 py-2">
                    <BlurText
                      value={component.supplier ?? ""}
                      onCommit={(value) =>
                        patchComponent(component.id, { supplier: value || null })
                      }
                    />
                  </td>
                  <td className="w-36 px-2 py-2">
                    <BlurText
                      value={component.finish ?? ""}
                      onCommit={(value) =>
                        patchComponent(component.id, { finish: value || null })
                      }
                    />
                  </td>
                  <td className="w-24 px-2 py-2">
                    <BlurNumber
                      value={component.quantity_per_item}
                      min={0.001}
                      onCommit={(value) =>
                        patchComponent(component.id, { quantity_per_item: value ?? 1 })
                      }
                    />
                    <p className="mt-1 text-right text-caption text-charcoal/40">{component.unit}</p>
                  </td>
                  <td className="px-2 py-3 text-right text-body text-charcoal/70">
                    {requiredQuantity(component)} {component.unit}
                  </td>
                  <td className="w-28 px-2 py-2">
                    <BlurNumber
                      value={component.price_trade}
                      min={0}
                      onCommit={(value) => patchComponent(component.id, { price_trade: value })}
                    />
                  </td>
                  <td className="px-2 py-3 text-right text-body text-nearblack">
                    {component.price_trade === null
                      ? "—"
                      : aud.format(component.price_trade * component.quantity_per_item)}
                  </td>
                  <td className="w-20 px-2 py-2">
                    <BlurNumber
                      value={component.lead_time_weeks}
                      min={0}
                      onCommit={(value) =>
                        patchComponent(component.id, { lead_time_weeks: value })
                      }
                    />
                  </td>
                  <td className="px-2 py-2">
                    <BlurDate
                      value={component.ordered_at}
                      onCommit={(value) => patchComponent(component.id, { ordered_at: value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <BlurDate
                      value={component.eta}
                      onCommit={(value) => patchComponent(component.id, { eta: value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <BlurDate
                      value={component.delivered_at}
                      onCommit={(value) => patchComponent(component.id, { delivered_at: value })}
                    />
                  </td>
                  <td className="px-2 py-3">
                    <button
                      type="button"
                      disabled={saving === component.id}
                      onClick={() => deleteComponent(component)}
                      className="text-caption text-charcoal/40 hover:text-red-700 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding ? (
        <div className="space-y-3 border border-[#dcd6cc] bg-cream p-3">
          <div>
            <p className="label-caps">Add from the library</p>
            <input
              autoFocus
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search for a body, trim kit, cartridge or other part…"
              className={`${inputClass} mt-2`}
            />
            {search.trim() && (
              <div className="mt-2 max-h-44 overflow-y-auto border border-[#dcd6cc] bg-nearwhite">
                {libraryLoading ? (
                  <p className="p-3 text-caption text-charcoal/50">Searching…</p>
                ) : libraryResults.length ? (
                  libraryResults.map((libraryItem) => (
                    <button
                      key={libraryItem.id}
                      type="button"
                      onClick={() =>
                        createComponent({
                          library_item_id: libraryItem.id,
                          quantity_per_item: 1,
                        })
                      }
                      className="flex w-full items-center justify-between gap-3 border-b border-[#e5e0d6] px-3 py-2 text-left hover:bg-offwhite"
                    >
                      <span>
                        <span className="block text-body text-nearblack">{libraryItem.name}</span>
                        <span className="block text-caption text-charcoal/50">
                          {[libraryItem.brand, libraryItem.supplier].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                      <span className="shrink-0 text-caption text-charcoal/60">
                        {libraryItem.price_trade === null || libraryItem.price_trade === undefined
                          ? "No trade price"
                          : aud.format(libraryItem.price_trade)}
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="p-3 text-caption text-charcoal/50">No library products found.</p>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-[#dcd6cc] pt-3">
            <p className="label-caps">Or add a new component</p>
            <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
              <input
                value={form.name}
                onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Part name"
                className={`${inputClass} col-span-2`}
              />
              <input
                value={form.supplier_item_code}
                onChange={(event) =>
                  setForm((current) => ({ ...current, supplier_item_code: event.target.value }))
                }
                placeholder="SKU"
                className={inputClass}
              />
              <input
                value={form.supplier}
                onChange={(event) =>
                  setForm((current) => ({ ...current, supplier: event.target.value }))
                }
                placeholder="Supplier"
                className={inputClass}
              />
              <input
                value={form.finish}
                onChange={(event) =>
                  setForm((current) => ({ ...current, finish: event.target.value }))
                }
                placeholder="Finish (if visible)"
                className={inputClass}
              />
              <input
                type="number"
                step="0.001"
                min="0.001"
                value={form.quantity_per_item}
                onChange={(event) =>
                  setForm((current) => ({ ...current, quantity_per_item: event.target.value }))
                }
                placeholder="Qty per item"
                className={inputClass}
              />
              <input
                value={form.unit}
                onChange={(event) => setForm((current) => ({ ...current, unit: event.target.value }))}
                placeholder="Unit"
                className={inputClass}
              />
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.price_trade}
                onChange={(event) =>
                  setForm((current) => ({ ...current, price_trade: event.target.value }))
                }
                placeholder="Unit trade $"
                className={inputClass}
              />
              <input
                type="number"
                step="0.1"
                min="0"
                value={form.lead_time_weeks}
                onChange={(event) =>
                  setForm((current) => ({ ...current, lead_time_weeks: event.target.value }))
                }
                placeholder="Lead weeks"
                className={inputClass}
              />
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={!form.name.trim() || saving === "new"}
                onClick={() =>
                  createComponent({
                    name: form.name,
                    supplier_item_code: form.supplier_item_code || null,
                    supplier: form.supplier || null,
                    finish: form.finish || null,
                    quantity_per_item: Number(form.quantity_per_item) || 1,
                    unit: form.unit || "ea",
                    price_trade: form.price_trade === "" ? null : Number(form.price_trade),
                    lead_time_weeks:
                      form.lead_time_weeks === "" ? null : Number(form.lead_time_weeks),
                  })
                }
                className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-40"
              >
                {saving === "new" ? "Adding…" : "Add component"}
              </button>
              <button
                type="button"
                onClick={() => setAdding(false)}
                className="px-3 py-2 text-caption text-charcoal/60 hover:text-nearblack"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="border border-nearblack px-4 py-2 text-subhead text-nearblack hover:bg-nearblack hover:text-white"
          >
            + Add component
          </button>
          {components.length > 0 && (
            <button
              type="button"
              disabled={saving === "template"}
              onClick={saveTemplate}
              className="border border-sand px-4 py-2 text-subhead text-sand hover:bg-sand hover:text-white disabled:opacity-40"
            >
              {saving === "template" ? "Saving…" : "Save as reusable assembly"}
            </button>
          )}
          {templateMessage && <p className="text-caption text-[#46604a]">{templateMessage}</p>}
        </div>
      )}
    </div>
  );
}

function BlurText({
  value,
  onCommit,
}: {
  value: string;
  onCommit: (value: string) => void;
}) {
  return (
    <input
      key={value}
      defaultValue={value}
      onBlur={(event) => {
        const next = event.target.value.trim();
        if (next !== value) onCommit(next);
      }}
      className={inputClass}
    />
  );
}

function BlurNumber({
  value,
  min,
  onCommit,
}: {
  value: number | null;
  min: number;
  onCommit: (value: number | null) => void;
}) {
  return (
    <input
      key={String(value)}
      type="number"
      step="any"
      min={min}
      defaultValue={value ?? ""}
      onBlur={(event) => {
        const next = event.target.value === "" ? null : Number(event.target.value);
        if (next !== value) onCommit(next);
      }}
      className={`${inputClass} text-right`}
    />
  );
}

function BlurDate({
  value,
  onCommit,
}: {
  value: string | null;
  onCommit: (value: string | null) => void;
}) {
  return (
    <input
      key={String(value)}
      type="date"
      defaultValue={value ?? ""}
      onBlur={(event) => {
        const next = event.target.value || null;
        if (next !== value) onCommit(next);
      }}
      className={inputClass}
    />
  );
}
