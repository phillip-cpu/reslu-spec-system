"use client";

import { useCallback, useEffect, useState } from "react";
import { formatMoney } from "./EstimateWorkspace";
import { VersionCompare } from "./VersionCompare";
import type { EstimateVersion, EstimateVersionSummary } from "@/types/phase-12a-a";

interface Props {
  projectId: string;
}

/**
 * Estimate versioning + VM comparison — BUILD-SPEC.md "Phase 12a — My
 * Work + estimate versioning with VM": "'Save version' from the
 * Estimate tab (freeze current state); versions list with view
 * (read-only render of snapshot). VM comparison view — the
 * deliverable: side-by-side any version vs current (or vs another
 * version)."
 *
 * Owns its own fetch/refresh cycle, mirroring EstimateWorkspace/
 * SowBuilder's pattern for their own tab — this is mounted as a third
 * view alongside Estimate/Variations/Measurements in
 * EstimateWorkspace.tsx (admin-only, same gate as every other Estimate
 * surface).
 */
export function VersionsPanel({ projectId }: Props) {
  const [versions, setVersions] = useState<EstimateVersionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [kindDraft, setKindDraft] = useState<"issue" | "vm">("issue");
  const [noteDraft, setNoteDraft] = useState("");
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<EstimateVersion | null>(null);
  const [compareA, setCompareA] = useState<string>("current");
  const [compareB, setCompareB] = useState<string>("current");
  const [comparing, setComparing] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/versions`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not load estimate versions.");
      setVersions(body.versions ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load estimate versions.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveVersion(e: React.FormEvent) {
    e.preventDefault();
    if (!labelDraft.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: labelDraft.trim(), kind: kindDraft, note: noteDraft.trim() || undefined }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save this version.");
      setLabelDraft("");
      setNoteDraft("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this version.");
    } finally {
      setSaving(false);
    }
  }

  async function viewVersion(id: string) {
    setViewingId(id);
    setViewing(null);
    try {
      const res = await fetch(`/api/versions/${id}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not load this version.");
      setViewing(body.version as EstimateVersion);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this version.");
    }
  }

  async function deleteVersion(id: string, label: string) {
    if (!confirm(`Delete version "${label}"? This can't be undone.`)) return;
    try {
      const res = await fetch(`/api/versions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? "Could not delete this version.");
      }
      if (viewingId === id) {
        setViewingId(null);
        setViewing(null);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this version.");
    }
  }

  if (loading) {
    return <p className="text-body text-charcoal/50">Loading estimate versions…</p>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      {/* Save version */}
      <form
        onSubmit={saveVersion}
        className="flex flex-wrap items-end gap-3 border border-nearblack bg-offwhite px-5 py-4"
      >
        <div>
          <label className="label-caps mb-1 block">Label</label>
          <input
            value={labelDraft}
            onChange={(e) => setLabelDraft(e.target.value)}
            placeholder="e.g. V1, VM_V2"
            className="w-40 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </div>
        <div>
          <label className="label-caps mb-1 block">Kind</label>
          <select
            value={kindDraft}
            onChange={(e) => setKindDraft(e.target.value as "issue" | "vm")}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="issue">Issue</option>
            <option value="vm">VM (Value Management)</option>
          </select>
        </div>
        <div className="min-w-[220px] flex-1">
          <label className="label-caps mb-1 block">Note</label>
          <input
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            placeholder="Optional note"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </div>
        <button
          type="submit"
          disabled={saving || !labelDraft.trim()}
          className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save version"}
        </button>
      </form>

      {/* Versions list */}
      {versions.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/60">
          No versions saved yet. Save one above to freeze the current estimate state.
        </p>
      ) : (
        <div className="border border-[#dcd6cc]">
          <div className="divide-y divide-[#e5e0d6]">
            {versions.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <div>
                  <p className="text-subhead text-nearblack">
                    {v.label}{" "}
                    <span
                      className={
                        v.kind === "vm"
                          ? "label-caps !text-[#BA7517]"
                          : "label-caps !text-charcoal/40"
                      }
                    >
                      {v.kind === "vm" ? "VM" : "Issue"}
                    </span>
                  </p>
                  <p className="text-caption text-charcoal/50">
                    {new Date(v.created_at).toLocaleDateString("en-AU")}
                    {v.note ? ` — ${v.note}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => viewVersion(v.id)}
                    className="text-caption text-sand hover:text-nearblack"
                  >
                    View
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteVersion(v.id, v.label)}
                    className="text-caption text-red-700/60 hover:text-red-700"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Read-only version viewer */}
      {viewingId && (
        <div className="border border-nearblack bg-offwhite p-5">
          <div className="mb-3 flex items-center justify-between">
            <p className="label-caps">Version viewer</p>
            <button
              type="button"
              onClick={() => {
                setViewingId(null);
                setViewing(null);
              }}
              className="text-caption text-charcoal/50 hover:text-nearblack"
            >
              Close
            </button>
          </div>
          {!viewing ? (
            <p className="text-body text-charcoal/50">Loading…</p>
          ) : (
            <VersionSnapshotView version={viewing} />
          )}
        </div>
      )}

      {/* VM comparison */}
      {versions.length > 0 && (
        <div className="border border-[#dcd6cc] bg-offwhite p-5">
          <p className="label-caps mb-3">VM comparison</p>
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="label-caps mb-1 block">Was (A)</label>
              <select
                value={compareA}
                onChange={(e) => setCompareA(e.target.value)}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              >
                <option value="current">Current (live)</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label-caps mb-1 block">Now (B)</label>
              <select
                value={compareB}
                onChange={(e) => setCompareB(e.target.value)}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              >
                <option value="current">Current (live)</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </div>
            <button
              type="button"
              onClick={() => setComparing(true)}
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Compare
            </button>
          </div>

          {comparing && (
            <div className="mt-6">
              <VersionCompare projectId={projectId} a={compareA} b={compareB} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Minimal read-only render of a frozen snapshot — reuses formatMoney; deliberately simple (a plain per-section table), not the full interactive EstimateView. */
function VersionSnapshotView({ version }: { version: EstimateVersion }) {
  const { snapshot } = version;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4 border border-nearblack bg-cream px-4 py-3">
        <div>
          <p className="label-caps mb-1">Whole job total — inc GST</p>
          <p className="font-display text-section text-nearblack">
            {formatMoney(snapshot.wholeJob.combinedIncGst)}
          </p>
        </div>
        <p className="text-caption text-charcoal/50">
          Markup {(snapshot.markup_pct * 100).toFixed(1)}%
          {snapshot.sow_revision_label ? ` — SOW ${snapshot.sow_revision_label}` : ""}
        </p>
      </div>
      {snapshot.sections.map((section) => (
        <div key={section.id} className="border border-[#dcd6cc]">
          <div className="flex items-center justify-between bg-cream px-4 py-2">
            <p className="label-caps !text-nearblack">{section.name}</p>
            <p className="text-caption text-charcoal/50">{formatMoney(section.rollup.costExGst)}</p>
          </div>
          <div className="divide-y divide-[#e5e0d6]">
            {section.lines.map((line) => (
              <div key={line.id} className="flex items-center justify-between px-4 py-2">
                <p className="text-body text-charcoal">{line.description}</p>
                <p className="text-body text-charcoal/70">
                  {line.cost_ex_gst !== null
                    ? formatMoney(line.cost_ex_gst)
                    : line.qty !== null && line.rate_ex_gst !== null
                      ? formatMoney(line.qty * line.rate_ex_gst)
                      : "—"}
                </p>
              </div>
            ))}
            {section.lines.length === 0 && (
              <p className="px-4 py-3 text-caption text-charcoal/40">No lines in this section.</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
