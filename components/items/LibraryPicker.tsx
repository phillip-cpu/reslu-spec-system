"use client";

import { useEffect, useState } from "react";
import type { Category, Item, LibraryItem } from "@/types";

interface Props {
  projectId: string;
  categories: Category[];
  onAdd: (item: Item) => void;
  onError: (msg: string | null) => void;
}

export function LibraryPicker({ projectId, categories, onAdd, onError }: Props) {
  const [q, setQ] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [results, setResults] = useState<LibraryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingId, setAddingId] = useState<string | null>(null);
  const [addedId, setAddedId] = useState<string | null>(null);

  const categoryName = new Map(categories.map((c) => [c.prefix, c.name]));

  useEffect(() => {
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      setLoading(true);
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      if (categoryFilter) params.set("category", categoryFilter);
      fetch(`/api/library?${params}`, { signal: ctrl.signal })
        .then((r) => r.json())
        .then((d) => setResults(d.items ?? []))
        .catch(() => {})
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, categoryFilter]);

  async function add(lib: LibraryItem) {
    setAddingId(lib.id);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ library_item_id: lib.id }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add");
      const { item } = await res.json();
      onAdd(item);
      setAddedId(lib.id);
      setTimeout(() => setAddedId((cur) => (cur === lib.id ? null : cur)), 1500);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add");
    } finally {
      setAddingId(null);
    }
  }

  return (
    <div className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex flex-wrap items-center gap-2">
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search the library…"
          className="min-w-[200px] flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <select
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
        >
          <option value="">All categories</option>
          {categories.map((c) => (
            <option key={c.prefix} value={c.prefix}>
              {c.prefix} · {c.name}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p className="text-body text-charcoal/50">Loading…</p>
      ) : results.length === 0 ? (
        <p className="text-body text-charcoal/50">
          {q || categoryFilter
            ? "No products match."
            : "The library is empty — add products under Library first."}
        </p>
      ) : (
        <ul className="max-h-72 divide-y divide-[#e5e0d6] overflow-y-auto border border-[#dcd6cc] bg-nearwhite">
          {results.map((lib) => (
            <li
              key={lib.id}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-body text-nearblack">
                  <span className="label-caps mr-2">{lib.category}</span>
                  {lib.name}
                </p>
                <p className="truncate text-caption text-charcoal/50">
                  {[lib.brand, lib.supplier, categoryName.get(lib.category)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              </div>
              <button
                type="button"
                disabled={addingId === lib.id}
                onClick={() => add(lib)}
                className="shrink-0 border border-nearblack px-3 py-1.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
              >
                {addingId === lib.id
                  ? "Adding…"
                  : addedId === lib.id
                    ? "Added ✓"
                    : "Add"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-charcoal/40">
        Adds a copy to this project (its own item code); edits here don&apos;t
        change the library original.
      </p>
    </div>
  );
}
