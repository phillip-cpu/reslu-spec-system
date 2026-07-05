"use client";

import { useCallback, useEffect, useState } from "react";

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

  const reload = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}/handover`);
      if (!res.ok) throw new Error("Could not load handover candidates.");
      const data = await res.json();
      setProjectFiles(data.project_files ?? []);
      setItemFiles(data.item_files ?? []);
      setSitePhotos(data.site_photos ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load handover candidates.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  async function toggle(table: "project_files" | "item_files" | "site_photos", id: string, next: boolean) {
    setError(null);
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
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading…</p>;

  return (
    <div className="space-y-8">
      <p className="text-body text-charcoal/70">
        Tick which files and photos belong in the client&apos;s Handover pack. The section appears on the portal once the
        project&apos;s status is set to Completed.
      </p>

      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <CurationList
        label="Compliance certificates & documents"
        empty="No certificates or shared documents yet."
        items={projectFiles.map((f) => ({ id: f.id, label: f.filename, checked: f.in_handover_pack }))}
        onToggle={(id, next) => toggle("project_files", id, next)}
      />

      <CurationList
        label="Manuals & warranties"
        empty="No install manuals or warranties uploaded to items yet."
        items={itemFiles.map((f) => ({ id: f.id, label: `${f.item_name ? `${f.item_name} — ` : ""}${f.filename}`, checked: f.in_handover_pack }))}
        onToggle={(id, next) => toggle("item_files", id, next)}
      />

      <CurationList
        label="Final gallery"
        empty="No site photos yet."
        items={sitePhotos.map((p) => ({
          id: p.id,
          label: p.caption || new Date(p.taken_at).toLocaleDateString("en-AU"),
          checked: p.in_handover_pack,
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
  items: { id: string; label: string; checked: boolean }[];
  onToggle: (id: string, next: boolean) => void;
}) {
  return (
    <div>
      <p className="label-caps mb-2 !text-sand">{label}</p>
      {items.length === 0 ? (
        <p className="text-body text-charcoal/50">{empty}</p>
      ) : (
        <ul className="space-y-1">
          {items.map((it) => (
            <li key={it.id} className="flex items-center justify-between gap-3 border-b border-[#e5e0d6] py-2">
              <span className="truncate text-body text-charcoal/80">{it.label}</span>
              <label className="flex shrink-0 items-center gap-2 text-caption text-charcoal/60">
                <input type="checkbox" checked={it.checked} onChange={(e) => onToggle(it.id, e.target.checked)} />
                In handover pack
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
