"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { LEAD_STAGES, type Lead, type LeadStageEvent, type PatchLeadInput } from "@/types";

interface Props {
  lead: Lead;
  onClose: () => void;
  onPatch: (patch: PatchLeadInput) => Promise<Lead>;
  onMoveStage: (stage: string) => Promise<void>;
  onDelete: () => void;
  onProjectCreated: (projectId: string) => void;
}

function toDateInput(iso: string | null): string {
  if (!iso) return "";
  return iso.slice(0, 10);
}

function toDateTimeLocal(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Detail panel — BUILD-SPEC.md "Detail panel: all fields editable
 * (single-save row pattern like estimate lines), stage history
 * timeline from lead_stage_events, notes. 'Create project' button
 * when stage = Design Work In Progress."
 *
 * Single-save pattern mirrors components/estimate/EstimateView.tsx's
 * LineRow: a local `draft` mirrors the lead, edits mark `dirty`, one
 * batched PATCH commits everything, blur-away-from-panel also
 * triggers a save (same as the estimate line's row-blur autosave).
 * Rendered as a slide-over panel, not a full-page route, so the
 * board/list stays mounted underneath.
 */
export function LeadDetailPanel({ lead, onClose, onPatch, onMoveStage, onDelete, onProjectCreated }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Lead>(lead);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LeadStageEvent[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);

  useEffect(() => {
    setDraft(lead);
    setDirty(false);
  }, [lead]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/leads/${lead.id}/history`)
      .then((r) => (r.ok ? r.json() : { events: [] }))
      .then((body) => {
        if (!cancelled) setEvents(body.events ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [lead.id]);

  function setField<K extends keyof Lead>(key: K, value: Lead[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const patch: PatchLeadInput = {
      surname_project: draft.surname_project,
      first_name: draft.first_name,
      source: draft.source,
      email: draft.email,
      phone: draft.phone,
      location: draft.location,
      received_at: draft.received_at,
      follow_up_date: draft.follow_up_date,
      site_visit_date: draft.site_visit_date,
      site_visit_location: draft.site_visit_location,
      construction_value: draft.construction_value,
      design_value: draft.design_value,
      design_start: draft.design_start,
      design_end: draft.design_end,
      construction_start: draft.construction_start,
      construction_end: draft.construction_end,
      notes: draft.notes,
    };
    try {
      const updated = await onPatch(patch);
      setDraft(updated);
      setDirty(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save this lead.");
    } finally {
      setSaving(false);
    }
  }

  function handlePanelBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    save();
  }

  async function handleStageChange(stage: string) {
    setError(null);
    try {
      await onMoveStage(stage);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not move stage.");
    }
  }

  async function handleCreateProject() {
    setCreatingProject(true);
    setError(null);
    try {
      const res = await fetch(`/api/leads/${lead.id}/create-project`, { method: "POST" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create project.");
      onProjectCreated(body.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create project.");
    } finally {
      setCreatingProject(false);
    }
  }

  const inputClass =
    "w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none";
  const labelClass = "label-caps mb-1 block !text-charcoal/50";

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-nearblack/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        onBlur={handlePanelBlur}
        className={clsx(
          "h-full w-full max-w-lg overflow-y-auto bg-cream p-6 shadow-lg",
          dirty && "ring-1 ring-inset ring-sand"
        )}
      >
        <div className="mb-4 flex items-center justify-between">
          <p className="label-caps !text-charcoal/50">Lead detail</p>
          <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close ✕
          </button>
        </div>

        {error && <p className="mb-3 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Name / project</span>
              <input
                value={draft.surname_project}
                onChange={(e) => setField("surname_project", e.target.value)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>First name</span>
              <input
                value={draft.first_name ?? ""}
                onChange={(e) => setField("first_name", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Stage</span>
              <select
                value={draft.stage}
                onChange={(e) => handleStageChange(e.target.value)}
                className={inputClass}
              >
                {LEAD_STAGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Source</span>
              <select
                value={draft.source ?? ""}
                onChange={(e) => setField("source", (e.target.value || null) as Lead["source"])}
                className={inputClass}
              >
                <option value="">—</option>
                <option value="META">META</option>
                <option value="DIRECT">DIRECT</option>
              </select>
            </label>
            <label className="block">
              <span className={labelClass}>Email</span>
              <input
                type="email"
                value={draft.email ?? ""}
                onChange={(e) => setField("email", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Phone</span>
              <input
                value={draft.phone ?? ""}
                onChange={(e) => setField("phone", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Location</span>
              <input
                value={draft.location ?? ""}
                onChange={(e) => setField("location", e.target.value || null)}
                className={inputClass}
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Follow-up date</span>
              <input
                type="date"
                value={toDateInput(draft.follow_up_date)}
                onChange={(e) => setField("follow_up_date", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Site visit date/time</span>
              <input
                type="datetime-local"
                value={toDateTimeLocal(draft.site_visit_date)}
                onChange={(e) =>
                  setField("site_visit_date", e.target.value ? new Date(e.target.value).toISOString() : null)
                }
                className={inputClass}
              />
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Site visit location note</span>
              <input
                value={draft.site_visit_location ?? ""}
                onChange={(e) => setField("site_visit_location", e.target.value || null)}
                className={inputClass}
              />
            </label>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className={labelClass}>Construction value ($)</span>
              <input
                type="number"
                min="0"
                value={draft.construction_value ?? ""}
                onChange={(e) => setField("construction_value", e.target.value ? Number(e.target.value) : null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Design value ($)</span>
              <input
                type="number"
                min="0"
                value={draft.design_value ?? ""}
                onChange={(e) => setField("design_value", e.target.value ? Number(e.target.value) : null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Design start</span>
              <input
                type="date"
                value={toDateInput(draft.design_start)}
                onChange={(e) => setField("design_start", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Design end</span>
              <input
                type="date"
                value={toDateInput(draft.design_end)}
                onChange={(e) => setField("design_end", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Construction start</span>
              <input
                type="date"
                value={toDateInput(draft.construction_start)}
                onChange={(e) => setField("construction_start", e.target.value || null)}
                className={inputClass}
              />
            </label>
            <label className="block">
              <span className={labelClass}>Construction end</span>
              <input
                type="date"
                value={toDateInput(draft.construction_end)}
                onChange={(e) => setField("construction_end", e.target.value || null)}
                className={inputClass}
              />
            </label>
          </div>

          <label className="block">
            <span className={labelClass}>Notes</span>
            <textarea
              value={draft.notes ?? ""}
              onChange={(e) => setField("notes", e.target.value || null)}
              rows={4}
              className={inputClass}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2">
            {dirty && (
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="bg-nearblack px-4 py-2 text-caption text-white hover:bg-charcoal disabled:opacity-50"
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            )}

            {draft.stage === "Design Work In Progress" && !draft.project_id && (
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={creatingProject}
                className="border border-sand px-4 py-2 text-caption text-sand hover:bg-sand hover:text-white disabled:opacity-50"
              >
                {creatingProject ? "Creating…" : "Create project"}
              </button>
            )}
            {draft.project_id && (
              <button
                type="button"
                onClick={() => router.push(`/projects/${draft.project_id}`)}
                className="border border-[#c9c2b4] px-4 py-2 text-caption text-charcoal hover:border-nearblack"
              >
                View linked project →
              </button>
            )}

            <button
              type="button"
              onClick={onDelete}
              className="ml-auto text-caption text-red-700/70 hover:text-red-700"
            >
              Delete lead
            </button>
          </div>

          <div className="border-t border-[#dcd6cc] pt-4">
            <p className="label-caps mb-2 !text-charcoal/50">Stage history</p>
            {events.length === 0 ? (
              <p className="text-caption text-charcoal/40">No stage changes recorded yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {events.map((e) => (
                  <li key={e.id} className="text-caption text-charcoal/60">
                    <span className="text-charcoal/40">
                      {new Date(e.at).toLocaleDateString("en-AU", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })}
                    </span>{" "}
                    {e.from_stage ? `${e.from_stage} → ${e.to_stage}` : `Created in ${e.to_stage}`}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
