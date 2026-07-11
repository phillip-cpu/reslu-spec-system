"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { LEAD_STAGES, type Lead, type LeadStageEvent, type PatchLeadInput } from "@/types";
import { googleCalendarUrl } from "@/lib/ics";
import { AddToCalendarMenu } from "@/components/shared/AddToCalendarMenu";
import type { InviteeOption } from "@/types/phase-small-round";
import type { StandardItemIdsInput } from "@/types/round-d";
import { LeadNotes } from "@/components/leads/LeadNotes";
import { LeadAttachments } from "@/components/leads/LeadAttachments";
import { StandardItemsChecklist } from "@/components/projects/StandardItemsChecklist";
import { VisitEmailStatusChips } from "@/components/shared/VisitEmailStatusChips";
import { BRIEF_ANSWER_FIELDS, type LeadWithBriefFields } from "@/types/round-lead-flow";
import { ProposalsSection } from "@/components/proposals/ProposalsSection";

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
 * Stages at which "Progress to job" is offered (Phase 11 extension, 5
 * July 2026 — Phillip): the lead is far enough along that a real job
 * exists or is imminent. Previously this only showed right after a
 * stage change into 'Design Work In Progress' (Week 10); widened to
 * also cover 'Construction In Progress' and 'Complete' so a lead that
 * skipped straight past Design (or was imported already further along)
 * isn't stuck with no way to create/link its job.
 */
const PROGRESS_TO_JOB_STAGES = new Set([
  "Design Work In Progress",
  "Construction In Progress",
  "Complete",
]);

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
 *
 * Phase 11 extension (5 July 2026 — Phillip): the "Create project"
 * button is relabelled "Progress to job" (route path unchanged — see
 * app/api/leads/[id]/create-project/route.ts) and is now offered at
 * three stages (see PROGRESS_TO_JOB_STAGES below), not only right
 * after a stage change into 'Design Work In Progress'.
 */
export function LeadDetailPanel({ lead, onClose, onPatch, onMoveStage, onDelete, onProjectCreated }: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Lead>(lead);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<LeadStageEvent[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  // Add-to-calendar invitee picker (BUILD-SPEC.md "Phillip's ideas
  // list — 6 July 2026" item 2) — team roster from the new
  // GET /api/profiles route, selected emails baked into both the .ics
  // ATTENDEE lines (server-side, via the ?attendees= query param on
  // GET /api/leads/[id]/calendar.ics) and the Google Calendar add= URL
  // (client-side, via lib/ics.ts googleCalendarUrl()).
  const [invitees, setInvitees] = useState<InviteeOption[]>([]);
  const [selectedInviteeEmails, setSelectedInviteeEmails] = useState<string[]>([]);
  // Migration 030 round — "Standard spec items" checklist, compact
  // variant, shown alongside "Progress to job" (see
  // components/projects/StandardItemsChecklist.tsx / handleCreateProject
  // below).
  const [standardItemIds, setStandardItemIds] = useState<string[]>([]);
  const [notesError, setNotesError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    fetch("/api/profiles")
      .then((r) => (r.ok ? r.json() : { profiles: [] }))
      .then((body) => {
        if (!cancelled) setInvitees(body.profiles ?? []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  function toggleInvitee(email: string) {
    setSelectedInviteeEmails((cur) =>
      cur.includes(email) ? cur.filter((e) => e !== email) : [...cur, email]
    );
  }

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
      // Migration 030 round: leads.notes is no longer editable via this
      // panel — the attributed lead_notes feed (LeadNotes, rendered
      // below) replaces it as the editable surface. Deliberately NOT
      // included in this PATCH body any more (contrast with the prior
      // version of this file, which sent `notes: draft.notes`).
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

  /**
   * "Progress to job" (Phase 11 extension, 5 July 2026 — Phillip's UI
   * rename of the Week 10 "Create project" action; the route path
   * itself is unchanged, see app/api/leads/[id]/create-project/route.ts).
   * Surfaced whenever the lead is far enough along that a job is real —
   * 'Design Work In Progress', 'Construction In Progress', or 'Complete'
   * — not only in the instant right after a stage change into Design
   * Work In Progress, so an admin catching up on older leads (already
   * sitting in Construction/Complete without ever having had a project
   * created) can still one-click it. Hidden once project_id is set
   * (idempotent route, but the UI shows "View linked project" instead).
   */
  async function handleCreateProject() {
    setCreatingProject(true);
    setError(null);
    try {
      // Migration 030 round: standard_item_ids rides along so the new
      // project's register is pre-seeded from the same checklist shown
      // just above the button (StandardItemsChecklist) — same body
      // field/shared copy helper as POST /api/projects.
      const payload: StandardItemIdsInput = { standard_item_ids: standardItemIds };
      const res = await fetch(`/api/leads/${lead.id}/create-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not create the job.");
      onProjectCreated(body.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the job.");
    } finally {
      setCreatingProject(false);
    }
  }

  const inputClass =
    "w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none";
  const labelClass = "label-caps mb-1 block !text-charcoal/50";

  // Lead flow round (048) — `draft` is typed `Lead` (types/index.ts,
  // protected); this widening cast is type-only, see
  // types/round-lead-flow.ts's LeadWithBriefFields doc comment.
  const briefLead = draft as LeadWithBriefFields;

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
              {/* Add to calendar (BUILD-SPEC.md "Phillip's ideas list —
                  6 July 2026" item 2) — only offered once a site visit
                  date actually exists; saved draft.site_visit_date (not
                  the unsaved local input) so the .ics route reads the
                  same persisted value. */}
              {draft.site_visit_date && (
                <div className="mt-1.5">
                  <AddToCalendarMenu
                    icsUrl={`/api/leads/${lead.id}/calendar.ics${
                      selectedInviteeEmails.length
                        ? `?attendees=${encodeURIComponent(selectedInviteeEmails.join(","))}`
                        : ""
                    }`}
                    googleUrl={googleCalendarUrl({
                      uid: `lead-site-visit-${lead.id}@reslu.com.au`,
                      title: `${[draft.first_name, draft.surname_project].filter(Boolean).join(" ") || draft.surname_project} — Site Visit`,
                      start: draft.site_visit_date,
                      location: draft.site_visit_location ?? draft.location ?? undefined,
                      attendees: selectedInviteeEmails.map((email) => ({ email })),
                    })}
                    invitees={invitees}
                    selectedInviteeEmails={selectedInviteeEmails}
                    onToggleInvitee={toggleInvitee}
                  />
                </div>
              )}
            </label>
            <label className="block sm:col-span-2">
              <span className={labelClass}>Site visit location note</span>
              <input
                value={draft.site_visit_location ?? ""}
                onChange={(e) => setField("site_visit_location", e.target.value || null)}
                className={inputClass}
              />
            </label>
            {/* Site-visit lifecycle emails (docs/RESLU-Spec-Visit-Emails-
                Brief.md) — last-sent status, e.g. "Confirmation sent 8
                Jul · Reminder pending". Renders nothing until a
                site-visit email has actually fired for this lead. */}
            {draft.site_visit_date && (
              <div className="sm:col-span-2">
                <VisitEmailStatusChips recordType="lead" recordId={lead.id} />
              </div>
            )}
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

          {/* Photos the prospect attached to the /begin enquiry form
              (POST /api/leads/intake, migration 042) — renders nothing
              for leads without attachments. */}
          <LeadAttachments leadId={lead.id} />

          {/* Migration 030 round: leads.notes free-text editing is
              retired from this panel — the attributed, timestamped
              lead_notes feed below is now the only editable notes
              surface (display migrated into the feed; see
              components/leads/LeadNotes.tsx and
              GET/POST /api/leads/[id]/notes). */}
          <div className="border-t border-[#dcd6cc] pt-4">
            {notesError && (
              <p className="mb-2 border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">
                {notesError}
              </p>
            )}
            <LeadNotes leadId={lead.id} onError={setNotesError} />
          </div>

          {/* Lead flow round (048) — read-only render of the client's
              submitted pre-visit questionnaire (emails/brief/project-
              brief.html, POST /api/brief-submit/[token]). Renders
              nothing until brief_submitted_at is set; blank answers are
              simply skipped (the form itself allows leaving any field
              blank — "Stuck on a question? Leave it blank"). Pen-blue
              (#274690) on the answer text is the one brand accent this
              round borrows from the card design (docs/RESLU-lead-flow-
              brief.md: "pen-blue accents optional but keep brand"). */}
          {briefLead.brief_submitted_at && (
            <div className="border-t border-[#dcd6cc] pt-4">
              <p className="label-caps mb-1 !text-charcoal/50">Project brief</p>
              <p className="mb-3 text-caption text-charcoal/40">
                Submitted{" "}
                {new Date(briefLead.brief_submitted_at).toLocaleDateString("en-AU", {
                  day: "numeric",
                  month: "short",
                  year: "numeric",
                })}
              </p>
              <dl className="space-y-2.5">
                {BRIEF_ANSWER_FIELDS.map(({ key, label }) => {
                  const value = briefLead.brief_answers?.[key];
                  if (!value) return null;
                  return (
                    <div key={key}>
                      <dt className="label-caps !text-charcoal/40">{label}</dt>
                      <dd className="text-body" style={{ color: "#274690" }}>
                        {value}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </div>
          )}

          {/* Fee proposal phase round (r23) — BUILD-SPEC.md item 3:
              "Builder UI on lead detail (+ projects): create from
              template ... list". Renders nothing but the "New proposal"
              composer + an empty state until at least one proposal
              exists for this lead — see components/proposals/
              ProposalsSection.tsx (shared with the project Invoices
              tab's own mount, which passes projectId instead). */}
          <div className="border-t border-[#dcd6cc] pt-4">
            <p className="label-caps mb-2 !text-charcoal/50">Fee proposal</p>
            <ProposalsSection leadId={lead.id} />
          </div>

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
          </div>

          {/* "Standard spec items" checklist (migration 030 round) —
              compact variant, shown only alongside the "Progress to
              job" affordance itself (renders nothing when no library
              items are flagged standard — see
              components/projects/StandardItemsChecklist.tsx). */}
          {PROGRESS_TO_JOB_STAGES.has(draft.stage) && !draft.project_id && (
            <StandardItemsChecklist selectedIds={standardItemIds} onChange={setStandardItemIds} compact />
          )}

          <div className="flex flex-wrap items-center gap-2">
            {PROGRESS_TO_JOB_STAGES.has(draft.stage) && !draft.project_id && (
              <button
                type="button"
                onClick={handleCreateProject}
                disabled={creatingProject}
                className="border border-sand px-4 py-2 text-caption text-sand hover:bg-sand hover:text-white disabled:opacity-50"
              >
                {creatingProject ? "Creating…" : "Progress to job"}
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
