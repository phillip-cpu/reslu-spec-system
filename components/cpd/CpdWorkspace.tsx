"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { createClient } from "@/lib/supabase/client";
import { ASSET_BUCKET } from "@/lib/storage";
import { CPD_CATEGORY_SUGGESTIONS, cpdEntriesToCsv, formatPoints, sumPoints } from "@/lib/cpd";
import type { CpdEntry, CpdListResponse } from "@/types/cpd";

// Manual month-abbreviation array, zero Intl/ICU dependency — same
// reasoning as MyWorkWorkspace.tsx's own SHORT_MONTHS (server-vs-client
// "short" month rendering can genuinely disagree between Node and
// Safari/WebKit for the same locale+options; a hardcoded array never
// can). Each feature keeps its own small copy rather than a shared
// lib/date-format client util, matching this codebase's existing
// convention (DailyBrief.tsx keeps its own too).
const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDateLong(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function todayISODate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * CPD point tracker workspace — BUILD-SPEC.md "CPD point tracker".
 * Own independent GET /api/cpd fetch (own entries, current licence-year
 * window) on mount; a second, admin-only "All team" fetch (?all=1)
 * loads lazily the first time the toggle is switched on, then is
 * refreshed alongside "mine" on every mutation while the toggle stays
 * on. The header progress bar always reflects the SIGNED-IN user's own
 * points — "All team" only changes what the entries list below shows,
 * never the header (this is always "my CPD", per BUILD-SPEC.md's own
 * worked example "14 / 12 points").
 */
export function CpdWorkspace() {
  const [mine, setMine] = useState<CpdListResponse | null>(null);
  const [all, setAll] = useState<CpdListResponse | null>(null);
  const [showAll, setShowAll] = useState(false);
  const [loadingAll, setLoadingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  async function loadMine() {
    try {
      const res = await fetch("/api/cpd");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load your CPD entries.");
      setMine(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load your CPD entries.");
    }
  }

  async function loadAll() {
    setLoadingAll(true);
    try {
      const res = await fetch("/api/cpd?all=1");
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not load the team's CPD entries.");
      setAll(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the team's CPD entries.");
    } finally {
      setLoadingAll(false);
    }
  }

  useEffect(() => {
    loadMine();
  }, []);

  useEffect(() => {
    if (showAll && !all) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  function refreshAfterMutation() {
    loadMine();
    if (showAll) loadAll();
  }

  const pointsToDate = mine ? sumPoints(mine.entries) : 0;
  const target = mine?.defaults.annual_target ?? 12;
  const fraction = target > 0 ? Math.min(1, pointsToDate / target) : 0;
  const overTarget = target > 0 && pointsToDate >= target;

  const teamGroups = useMemo(() => {
    if (!all) return [];
    const byPerson = new Map<string, { id: string; full_name: string; entries: CpdEntry[] }>();
    for (const entry of all.entries) {
      const key = entry.profile?.id ?? entry.user_id;
      const label = entry.profile?.full_name ?? "Unknown";
      const group = byPerson.get(key) ?? { id: key, full_name: label, entries: [] };
      group.entries.push(entry);
      byPerson.set(key, group);
    }
    return [...byPerson.values()].sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [all]);

  function downloadCsv() {
    const source = showAll && all ? all.entries : mine?.entries ?? [];
    if (source.length === 0) return;
    const csv = cpdEntriesToCsv(source, (e) => e.profile?.full_name ?? "Unknown");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const label = showAll ? "cpd-all-team" : "cpd-my-entries";
    a.href = url;
    a.download = `${label}-${todayISODate()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteEntry(id: string) {
    if (!confirm("Delete this CPD entry?")) return;
    try {
      const res = await fetch(`/api/cpd/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not delete this entry.");
      refreshAfterMutation();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this entry.");
    }
  }

  return (
    <div className="space-y-8">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      {/* ---- Progress header ---- */}
      <section className="border border-[#dcd6cc] bg-offwhite p-5">
        {!mine ? (
          <p className="text-body text-charcoal/50">Loading…</p>
        ) : (
          <>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-subhead text-nearblack">
                {formatPoints(pointsToDate)} / {formatPoints(target)} points
                {overTarget && <span className="ml-2 text-caption text-sand">Target reached</span>}
              </p>
              <p className="text-caption text-charcoal/50">
                Licence year ends {formatDateLong(mine.window.end)}
              </p>
            </div>
            <div className="mt-3 h-2 w-full bg-[#e5e0d6]">
              <div
                className={clsx("h-2 transition-all", overTarget ? "bg-sand" : "bg-sand/70")}
                style={{ width: `${Math.round(fraction * 100)}%` }}
              />
            </div>
          </>
        )}
      </section>

      {/* ---- Toolbar: add / all-team toggle / CSV export ---- */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setFormOpen((o) => !o)}
          className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal"
        >
          {formOpen ? "Cancel" : "+ Log a CPD activity"}
        </button>
        <div className="flex flex-wrap items-center gap-3">
          {mine?.is_admin && (
            <label className="flex items-center gap-2 text-caption text-charcoal/70">
              <input
                type="checkbox"
                checked={showAll}
                onChange={(e) => setShowAll(e.target.checked)}
                className="h-3.5 w-3.5 accent-nearblack"
              />
              All team
            </label>
          )}
          <button
            type="button"
            onClick={downloadCsv}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            Download CSV
          </button>
        </div>
      </div>
      <p className="-mt-5 text-caption text-charcoal/40">
        CSV export is a snapshot of what&apos;s currently loaded below. PDF export is deferred to a future round.
      </p>

      {formOpen && (
        <CpdEntryForm
          onCancel={() => setFormOpen(false)}
          onSaved={() => {
            setFormOpen(false);
            refreshAfterMutation();
          }}
        />
      )}

      {/* ---- Entries ---- */}
      {showAll ? (
        loadingAll && !all ? (
          <p className="text-body text-charcoal/50">Loading team entries…</p>
        ) : teamGroups.length === 0 ? (
          <p className="text-body text-charcoal/40">No CPD entries logged by anyone this licence year yet.</p>
        ) : (
          <div className="space-y-6">
            {teamGroups.map((group) => {
              const groupTotal = sumPoints(group.entries);
              const groupTarget = all?.defaults.annual_target ?? target;
              const groupFraction = groupTarget > 0 ? Math.min(1, groupTotal / groupTarget) : 0;
              return (
                <section key={group.id}>
                  <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                    <p className="text-subhead text-nearblack">{group.full_name}</p>
                    <p className="text-caption text-charcoal/50">
                      {formatPoints(groupTotal)} / {formatPoints(groupTarget)} points
                    </p>
                  </div>
                  <div className="mb-3 h-1.5 w-full bg-[#e5e0d6]">
                    <div
                      className={clsx("h-1.5", groupFraction >= 1 ? "bg-sand" : "bg-sand/70")}
                      style={{ width: `${Math.round(groupFraction * 100)}%` }}
                    />
                  </div>
                  <ul className="space-y-2">
                    {group.entries.map((entry) =>
                      editingId === entry.id ? (
                        <li key={entry.id}>
                          <CpdEntryForm
                            initialEntry={entry}
                            onCancel={() => setEditingId(null)}
                            onSaved={() => {
                              setEditingId(null);
                              refreshAfterMutation();
                            }}
                          />
                        </li>
                      ) : (
                        <CpdEntryRow
                          key={entry.id}
                          entry={entry}
                          onEdit={() => setEditingId(entry.id)}
                          onDelete={() => deleteEntry(entry.id)}
                        />
                      )
                    )}
                  </ul>
                </section>
              );
            })}
          </div>
        )
      ) : !mine ? null : mine.entries.length === 0 ? (
        <p className="text-body text-charcoal/40">
          No CPD entries logged yet this licence year — use &quot;+ Log a CPD activity&quot; above.
        </p>
      ) : (
        <ul className="space-y-2">
          {mine.entries.map((entry) =>
            editingId === entry.id ? (
              <li key={entry.id}>
                <CpdEntryForm
                  initialEntry={entry}
                  onCancel={() => setEditingId(null)}
                  onSaved={() => {
                    setEditingId(null);
                    refreshAfterMutation();
                  }}
                />
              </li>
            ) : (
              <CpdEntryRow
                key={entry.id}
                entry={entry}
                onEdit={() => setEditingId(entry.id)}
                onDelete={() => deleteEntry(entry.id)}
              />
            )
          )}
        </ul>
      )}
    </div>
  );
}

function CpdEntryRow({
  entry,
  onEdit,
  onDelete,
}: {
  entry: CpdEntry;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 border border-[#dcd6cc] bg-offwhite px-4 py-3">
      <span className="w-24 shrink-0 text-caption text-charcoal/50">{formatDateLong(entry.activity_date)}</span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-nearblack">{entry.activity_title}</p>
        <p className="mt-0.5 truncate text-caption text-charcoal/50">
          {entry.provider ? `${entry.provider} · ` : ""}
          {entry.category && (
            <span className="border border-[#c9c2b4] px-1 py-0.5 text-charcoal/60">{entry.category}</span>
          )}
        </p>
        {entry.notes && <p className="mt-0.5 truncate text-caption text-charcoal/40">{entry.notes}</p>}
      </div>
      {entry.evidence_url && (
        <a
          href={entry.evidence_url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-caption text-charcoal/60 hover:text-nearblack hover:underline"
        >
          Evidence →
        </a>
      )}
      <span className="shrink-0 text-body font-medium text-nearblack">{formatPoints(entry.points)} pts</span>
      <div className="flex shrink-0 gap-2">
        <button type="button" onClick={onEdit} className="text-caption text-charcoal/50 hover:text-nearblack">
          Edit
        </button>
        <button type="button" onClick={onDelete} className="text-caption text-charcoal/50 hover:text-red-700">
          Delete
        </button>
      </div>
    </li>
  );
}

/**
 * Single-save row/form — same shape whether adding a new entry
 * (initialEntry omitted) or editing an existing one (initialEntry
 * passed): one form, one Save button, no separate "confirm" step.
 * Evidence upload follows the two-step signed-URL flow (POST
 * /api/cpd/evidence/upload-url mints the URL/token, then the Supabase
 * JS client's storage.uploadToSignedUrl() PUTs the file directly to
 * Storage) — the exact same sequence ContactDocumentsPanel.tsx's
 * upload() already uses, just folded into this single combined
 * add/edit form rather than a separate always-visible upload widget.
 */
function CpdEntryForm({
  initialEntry,
  onCancel,
  onSaved,
}: {
  initialEntry?: CpdEntry;
  onCancel: () => void;
  onSaved: (entry: CpdEntry) => void;
}) {
  const [title, setTitle] = useState(initialEntry?.activity_title ?? "");
  const [provider, setProvider] = useState(initialEntry?.provider ?? "");
  const [date, setDate] = useState(initialEntry?.activity_date ?? todayISODate());
  const [points, setPoints] = useState(initialEntry ? String(initialEntry.points) : "");
  const [category, setCategory] = useState(initialEntry?.category ?? "");
  const [notes, setNotes] = useState(initialEntry?.notes ?? "");
  const [existingEvidenceFilename, setExistingEvidenceFilename] = useState(
    initialEntry?.evidence_filename ?? null
  );
  const [removeEvidence, setRemoveEvidence] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!title.trim() || !date || !points) {
      setError("Activity, date and points are all required.");
      return;
    }
    const pointsNum = Number(points);
    if (!Number.isFinite(pointsNum) || pointsNum <= 0) {
      setError("Points must be a positive number.");
      return;
    }
    setSaving(true);
    setError(null);

    try {
      const fileInput = e.currentTarget.elements.namedItem("evidence") as HTMLInputElement | null;
      const file = fileInput?.files?.[0];

      const body: Record<string, unknown> = {
        activity_title: title.trim(),
        provider: provider.trim() || null,
        activity_date: date,
        points: pointsNum,
        category: category.trim() || null,
        notes: notes.trim() || null,
      };

      if (file) {
        const urlRes = await fetch("/api/cpd/evidence/upload-url", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name }),
        });
        if (!urlRes.ok) throw new Error((await urlRes.json()).error ?? "Could not start the evidence upload");
        const { path, token } = await urlRes.json();

        const supabase = createClient();
        const { error: upErr } = await supabase.storage
          .from(ASSET_BUCKET)
          .uploadToSignedUrl(path, token, file, { contentType: file.type || "application/octet-stream" });
        if (upErr) throw new Error(upErr.message);

        body.evidence_path = path;
        body.evidence_filename = file.name;
      } else if (removeEvidence) {
        body.evidence_path = null;
        body.evidence_filename = null;
      }

      const res = await fetch(initialEntry ? `/api/cpd/${initialEntry.id}` : "/api/cpd", {
        method: initialEntry ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save this CPD entry.");
      const { entry } = await res.json();
      onSaved(entry);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this CPD entry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
      {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-4">
        <label className="block sm:col-span-2 md:col-span-2">
          <p className="label-caps mb-1">Activity</p>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. AS/NZS bathroom waterproofing webinar"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Provider</p>
          <input
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
            placeholder="Optional"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Date</p>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Points</p>
          <input
            type="number"
            min="0.01"
            step="0.01"
            value={points}
            onChange={(e) => setPoints(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Category</p>
          <input
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            list="cpd-category-suggestions"
            placeholder="Optional"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
          <datalist id="cpd-category-suggestions">
            {CPD_CATEGORY_SUGGESTIONS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>
        <label className="block sm:col-span-2 md:col-span-2">
          <p className="label-caps mb-1">Notes</p>
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Optional"
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block sm:col-span-2 md:col-span-4">
          <p className="label-caps mb-1">Evidence (optional)</p>
          {existingEvidenceFilename && !removeEvidence ? (
            <div className="flex items-center gap-2 text-caption text-charcoal/60">
              <span>{existingEvidenceFilename} on file</span>
              <button
                type="button"
                onClick={() => {
                  setRemoveEvidence(true);
                  setExistingEvidenceFilename(null);
                }}
                className="text-charcoal/50 hover:text-red-700"
              >
                Remove
              </button>
            </div>
          ) : (
            <input
              type="file"
              name="evidence"
              className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-caption focus:border-nearblack focus:outline-none"
            />
          )}
        </label>
      </div>

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-caption text-charcoal/50 hover:text-nearblack">
          Cancel
        </button>
        <button
          type="submit"
          disabled={saving}
          className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}
