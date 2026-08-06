"use client";

import { useEffect, useMemo, useState } from "react";
import {
  BROWSER_IMPORT_FIELDS,
  importedFieldValues,
  validateBrowserProductImport,
  type BrowserImportField,
  type BrowserProductImportPayload,
} from "@/lib/browser-product-import";

type ProjectOption = { id: string; name: string; status?: string };
type ItemOption = { id: string; item_code: string; name: string };
type ItemRecord = Record<string, unknown> & {
  id: string;
  item_code: string;
  name: string;
  updated_at: string;
};

const FIELD_LABELS: Record<BrowserImportField, string> = {
  name: "Product name",
  description: "Description",
  brand: "Brand",
  supplier: "Supplier",
  product_url: "Product URL",
  price_rrp: "Retail price",
  width_mm: "Width (mm)",
  height_mm: "Height (mm)",
  length_mm: "Length (mm)",
  depth_mm: "Depth (mm)",
  colour: "Colour",
  material: "Material",
  finish: "Finish",
  product_details: "Product details",
  image_options: "Image choices",
};

function hasValue(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && value !== "";
}

function displayValue(value: unknown): string {
  if (!hasValue(value)) return "—";
  if (Array.isArray(value)) {
    return value
      .slice(0, 4)
      .map((entry) =>
        typeof entry === "string"
          ? entry
          : `${String((entry as { label?: unknown }).label ?? "Detail")}: ${String(
              (entry as { value?: unknown }).value ?? ""
            )}`
      )
      .join(" · ") + (value.length > 4 ? ` · +${value.length - 4} more` : "");
  }
  if (typeof value === "number") return value.toLocaleString("en-AU");
  return String(value);
}

function decodePayload():
  | { payload: BrowserProductImportPayload; error: null }
  | { payload: null; error: string } {
  const fragment = window.location.hash.slice(1);
  if (!fragment) {
    return {
      payload: null,
      error: "No browser product was supplied. Open a supported product page and use the RESLU Product Importer extension.",
    };
  }
  try {
    const validation = validateBrowserProductImport(
      JSON.parse(decodeURIComponent(fragment))
    );
    return validation.ok
      ? { payload: validation.payload, error: null }
      : { payload: null, error: validation.error };
  } catch {
    return { payload: null, error: "The browser product payload could not be read." };
  }
}

export function BrowserProductImportReview() {
  const [payload, setPayload] = useState<BrowserProductImportPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [projectId, setProjectId] = useState("");
  const [items, setItems] = useState<ItemOption[]>([]);
  const [itemId, setItemId] = useState("");
  const [item, setItem] = useState<ItemRecord | null>(null);
  const [selected, setSelected] = useState<Set<BrowserImportField>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const imported = useMemo(
    () => (payload ? importedFieldValues(payload) : null),
    [payload]
  );

  useEffect(() => {
    Promise.resolve().then(() => {
      const decoded = decodePayload();
      setPayload(decoded.payload);
      setError(decoded.error);
      if (!decoded.payload) {
        setLoading(false);
        return;
      }
      fetch("/api/projects")
        .then(async (response) => {
          const json = await response.json();
          if (!response.ok) throw new Error(json.error ?? "Projects could not be loaded.");
          return json.projects as ProjectOption[];
        })
        .then((rows) => {
          setProjects(rows);
          const captured = decoded.payload?.context?.projectId;
          setProjectId(rows.some((row) => row.id === captured) ? captured! : "");
        })
        .catch((reason: Error) => setError(reason.message))
        .finally(() => setLoading(false));
    });
  }, []);

  useEffect(() => {
    if (!projectId) return;
    fetch(`/api/projects/${projectId}/items?limit=2000`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "FF&E items could not be loaded.");
        setItems(json.items as ItemOption[]);
      })
      .catch((reason: Error) => setError(reason.message));
  }, [projectId]);

  useEffect(() => {
    if (!itemId || !imported) return;
    fetch(`/api/items/${itemId}`)
      .then(async (response) => {
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? "The FF&E item could not be loaded.");
        const current = json.item as ItemRecord;
        setItem(current);
        setSelected(
          new Set(
            BROWSER_IMPORT_FIELDS.filter(
              (field) => hasValue(imported[field]) && !hasValue(current[field])
            )
          )
        );
      })
      .catch((reason: Error) => setError(reason.message));
  }, [itemId, imported]);

  function changeProject(nextProjectId: string) {
    setProjectId(nextProjectId);
    setItems([]);
    setItemId("");
    setItem(null);
    setSelected(new Set());
  }

  function changeItem(nextItemId: string) {
    setItemId(nextItemId);
    setItem(null);
    setSelected(new Set());
  }

  function toggle(field: BrowserImportField) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(field)) next.delete(field);
      else next.add(field);
      return next;
    });
  }

  async function applyImport() {
    if (!payload || !item || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(`/api/items/${item.id}/browser-import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          payload,
          selectedFields: [...selected],
          expectedUpdatedAt: item.updated_at,
        }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error ?? "The product import failed.");
      setSaved(true);
      history.replaceState(null, "", window.location.pathname);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The product import failed.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <p className="text-body text-charcoal/60">Loading import…</p>;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      {error && (
        <div className="border border-red-300 bg-red-50 px-5 py-4 text-sm text-red-700">
          <p>{error}</p>
          {!payload && (
            <a
              href="/product-import/setup"
              className="mt-2 inline-block font-medium underline underline-offset-2"
            >
              Install or set up the browser importer →
            </a>
          )}
        </div>
      )}
      {saved && item && (
        <div className="border border-green-300 bg-green-50 px-5 py-4 text-sm text-green-800">
          Product details were imported into {item.item_code} — {item.name}.{" "}
          <a className="underline" href={`/projects/${projectId}?tab=ffe`}>
            Return to FF&amp;E
          </a>
        </div>
      )}
      {payload && !saved && (
        <>
          <section className="border border-[#dcd6cc] bg-offwhite p-6">
            <p className="label-caps mb-2">Captured in your browser</p>
            <h2 className="text-xl text-nearblack">{payload.product.name ?? "Bunnings product"}</h2>
            <p className="mt-2 text-sm text-charcoal/60">
              {payload.source.pageKind === "trade" ? "Bunnings Trade" : "Bunnings retail"}
              {payload.context?.projectName ? ` · Last RESLU project: ${payload.context.projectName}` : ""}
            </p>
            <a
              className="mt-3 inline-block text-sm underline"
              href={payload.source.pageUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open supplier page ↗
            </a>
          </section>

          <section className="grid gap-4 border border-[#dcd6cc] bg-offwhite p-6 sm:grid-cols-2">
            <label className="text-sm">
              <span className="label-caps mb-2 block">Project</span>
              <select
                className="w-full border border-[#cfc7bb] bg-white px-3 py-3"
                value={projectId}
                onChange={(event) => changeProject(event.target.value)}
              >
                <option value="">Choose a project…</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>{project.name}</option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="label-caps mb-2 block">FF&amp;E item</span>
              <select
                className="w-full border border-[#cfc7bb] bg-white px-3 py-3"
                value={itemId}
                onChange={(event) => changeItem(event.target.value)}
                disabled={!projectId}
              >
                <option value="">Choose an item…</option>
                {items.map((row) => (
                  <option key={row.id} value={row.id}>{row.item_code} — {row.name}</option>
                ))}
              </select>
            </label>
          </section>

          {item && imported && (
            <section className="border border-[#dcd6cc] bg-offwhite">
              <div className="border-b border-[#dcd6cc] px-6 py-5">
                <p className="label-caps">Review changes</p>
                <p className="mt-2 text-sm text-charcoal/60">
                  Blank item fields are selected automatically. Existing values require an explicit tick.
                </p>
              </div>
              <div className="divide-y divide-[#e4ded5]">
                {BROWSER_IMPORT_FIELDS.filter((field) => hasValue(imported[field])).map((field) => {
                  const existing = item[field];
                  const changesExisting = hasValue(existing) && displayValue(existing) !== displayValue(imported[field]);
                  return (
                    <label key={field} className="grid cursor-pointer gap-3 px-6 py-4 sm:grid-cols-[32px_160px_1fr_1fr]">
                      <input
                        type="checkbox"
                        checked={selected.has(field)}
                        onChange={() => toggle(field)}
                        className="mt-1 h-4 w-4"
                      />
                      <span className="text-sm font-medium">{FIELD_LABELS[field]}</span>
                      <span className="min-w-0 break-words text-sm text-charcoal/55">
                        <span className="label-caps mb-1 block">Current</span>
                        {displayValue(existing)}
                      </span>
                      <span className="min-w-0 break-words text-sm text-nearblack">
                        <span className="label-caps mb-1 block">From browser</span>
                        {displayValue(imported[field])}
                        {changesExisting && !selected.has(field) && (
                          <span className="mt-1 block text-xs text-amber-700">Existing value preserved</span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <div className="flex items-center justify-between gap-4 border-t border-[#dcd6cc] px-6 py-5">
                <p className="text-sm text-charcoal/55">{selected.size} field{selected.size === 1 ? "" : "s"} selected</p>
                <button
                  type="button"
                  onClick={applyImport}
                  disabled={saving || selected.size === 0}
                  className="border border-nearblack bg-nearblack px-5 py-3 text-sm text-white disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? "Importing…" : "Confirm import"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
