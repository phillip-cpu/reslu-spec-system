"use client";

import { useState } from "react";
import type { Category } from "@/types";

interface Props {
  initialCategories: Category[];
  canEdit: boolean;
}

export function CategorySettings({ initialCategories, canEdit }: Props) {
  const [categories, setCategories] = useState<Category[]>(initialCategories);
  const [error, setError] = useState<string | null>(null);
  const [prefix, setPrefix] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!prefix.trim() || !name.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/categories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prefix,
          name,
          sort_order: (categories.at(-1)?.sort_order ?? 0) + 10,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add");
      const { category } = await res.json();
      setCategories((c) => [...c, category]);
      setPrefix("");
      setName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    } finally {
      setSaving(false);
    }
  }

  async function rename(id: string, newName: string) {
    const prev = categories;
    setCategories((c) => c.map((x) => (x.id === id ? { ...x, name: newName } : x)));
    const res = await fetch(`/api/categories/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (!res.ok) {
      setCategories(prev);
      setError((await res.json()).error ?? "Could not rename");
    }
  }

  async function remove(id: string) {
    const cat = categories.find((c) => c.id === id);
    if (!cat) return;
    if (!confirm(`Delete category "${cat.prefix} · ${cat.name}"?`)) return;
    const prev = categories;
    setCategories((c) => c.filter((x) => x.id !== id));
    const res = await fetch(`/api/categories/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setCategories(prev);
      setError((await res.json()).error ?? "Could not delete");
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <div className="divide-y divide-[#e5e0d6] border border-[#dcd6cc] bg-offwhite">
        {categories.map((c) => (
          <div key={c.id} className="flex items-center gap-3 px-4 py-2">
            <span className="w-10 text-body font-normal text-nearblack">
              {c.prefix}
            </span>
            {canEdit ? (
              <input
                defaultValue={c.name}
                onBlur={(e) => {
                  if (e.target.value.trim() && e.target.value !== c.name)
                    rename(c.id, e.target.value.trim());
                }}
                className="flex-1 bg-transparent px-2 py-1 text-body hover:bg-nearwhite focus:border focus:border-nearblack focus:bg-nearwhite focus:outline-none"
              />
            ) : (
              <span className="flex-1 px-2 py-1 text-body">{c.name}</span>
            )}
            {canEdit && (
              <button
                type="button"
                onClick={() => remove(c.id)}
                className="text-caption text-charcoal/50 hover:text-red-700"
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>

      {canEdit && (
        <form onSubmit={add} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="label-caps">Prefix</span>
            <input
              value={prefix}
              onChange={(e) => setPrefix(e.target.value.toUpperCase())}
              maxLength={4}
              placeholder="e.g. AV"
              className="w-24 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body uppercase focus:border-nearblack focus:outline-none"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="label-caps">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Audio Visual"
              className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Adding…" : "Add category"}
          </button>
        </form>
      )}
    </div>
  );
}
