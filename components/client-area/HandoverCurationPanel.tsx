"use client";

import { useEffect, useState } from "react";

interface ProjectFileRow {
  id: string;
  kind: string;
  filename: string;
  in_handover_pack: boolean;
}
interface ItemFileRow {
  id: string;
  kind: string;
  filename: string;
  in_handover_pack: boolean;
  item_name?: string;
}
interface SitePhotoRow {
  id: string;
  caption: string | null;
  taken_at: string;
  in_handover_pack: boolean;
}

/**
 * Internal curation UI for the Handover pack (BUILD-SPEC.md §"Phase 11
 * additions — confirmed by Phillip" point 4: "Internal curation UI:
 * tick which files/photos belong in the pack"). Plain tick-lists across
 * the three source tables — no need for anything fancier since this is
 * a one-time-per-project curation pass at project completion, not a
 * frequent workflow.
 */
export function HandoverCurationPanel({ projectId }: { projectId: string }) {
  const [projectFiles, setProjectFiles] = useState<ProjectFileRow[]>([]);
  const [itemFiles, setItemFiles] = useState<ItemFileRow[]>([]);
  const [sitePhotos, setSitePhotos] = useState<SitePhotoRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingKeys, setSavingKeys] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    fetch(`/api/projects/${projectId}/handover`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error ?? "Could not load handover candidates.");
        }
        if (active) {
          setProjectFiles(body.project_files ?? []);
          setItemFiles(body.item_files ?? []);
          setSitePhotos(body.site_photos ?? []);
        }
      })
      .catch((loadError) => {
        if (active) {
          setError(
            loadError instanceof Error
              ? loadError.message
              : "Could not load handover candidates."
          );
        }
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [projectId]);

  async function toggle(table: "project_files" | "item_files" | "site_photos", id: string, next: boolean) {
    const savingKey = `${table}:${id}`;
    if (savingKeys.has(savingKey)) return;
    setError(null);
    setSavingKeys((current) => new Set(current).add(savingKey));
    try {
      const res = await fetch(`/api/projects/${projectId}/handover`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ table, id, in_handover_pack: next }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update");
      if (table === "project_files") setProjectFiles((cur) => cur.map((f) => (f.id === id ? { ...f, in_handover_pack: next } : f)));
      if (table === "item_files") setItemFiles((cur) => cur.map((f) => (f.id === id ? { ...f, in_handover_pack: next } : f)));
      if (table === "site_photos") setSitePhotos((cur) => cur.map((p) => (p.id === id ? { ...p, in_handover_pack: next } : p)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
    } finally {
      setSavingKeys((current) => {
        const updated = new Set(current);
        updated.delete(savingKey);
        return updated;
      });
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading…</p>;

  const selectedCount =
    projectFiles.filter((file) => file.in_handover_pack).length +
    itemFiles.filter((file) => file.in_handover_pack).length +
    sitePhotos.filter((photo) => photo.in_handover_pack).length;
  const candidateCount = projectFiles.length + itemFiles.length + sitePhotos.length;

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-2 border border-[#dcd6cc] bg-offwhite p-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-body text-charcoal/70">
          Select the files and photos the client should receive. The pack becomes visible
          when the job is Finalised.
        </p>
        <span className="shrink-0 text-caption font-semibold text-nearblack">
          {selectedCount} of {candidateCount} selected
        </span>
      </div>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <CurationList
        label="Compliance certificates & documents"
        empty="No certificates or shared documents yet."
        items={projectFiles.map((f) => ({
          id: f.id,
          label: f.filename,
          checked: f.in_handover_pack,
          saving: savingKeys.has(`project_files:${f.id}`),
        }))}
        onToggle={(id, next) => toggle("project_files", id, next)}
      />

      <CurationList
        label="Manuals & warranties"
        empty="No install manuals or warranties uploaded to items yet."
        items={itemFiles.map((f) => ({
          id: f.id,
          label: `${f.item_name ? `${f.item_name} — ` : ""}${f.filename}`,
          checked: f.in_handover_pack,
          saving: savingKeys.has(`item_files:${f.id}`),
        }))}
        onToggle={(id, next) => toggle("item_files", id, next)}
      />

      <CurationList
        label="Final gallery"
        empty="No site photos yet."
        items={sitePhotos.map((p) => ({
          id: p.id,
          label: p.caption || new Date(p.taken_at).toLocaleDateString("en-AU"),
          checked: p.in_handover_pack,
          saving: savingKeys.has(`site_photos:${p.id}`),
        }))}
        onToggle={(id, next) => toggle("site_photos", id, next)}
      />
    </div>
  );
}

function CurationList({
  label,
  empty,
  items,
  onToggle,
}: {
  label: string;
  empty: string;
  items: { id: string; label: string; checked: boolean; saving: boolean }[];
  onToggle: (id: string, next: boolean) => void;
}) {
  return (
    <section className="border border-[#dcd6cc] bg-cream p-4">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="label-caps !text-sand">{label}</p>
        <span className="text-caption text-charcoal/50">
          {items.filter((item) => item.checked).length}/{items.length}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="text-body text-charcoal/50">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 border-b border-[#e5e0d6] py-2">
              <span className="truncate text-body text-charcoal/80">{it.label}</span>
              <label className="flex shrink-0 items-center gap-2 text-caption text-charcoal/60">
                <input
                  type="checkbox"
                  checked={it.checked}
                  disabled={it.saving}
                  onChange={(e) => onToggle(it.id, e.target.checked)}
                />
                {it.saving ? "Saving…" : "In handover pack"}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
