"use client";

import { useEffect, useMemo, useState } from "react";
import type { ContactPickerOption } from "@/types/board-cockpit";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";
import type { GroupableTask, CreateTradeBookingRequestResponse } from "@/types/round-grouped-trade-booking";
import { ContactPicker } from "@/components/shared/ContactPicker";
import { pickPresetForContactCategory } from "@/lib/export-presets";
import { scheduleLabel } from "@/lib/trade-doc-pack";
import type { ExportPresetRow } from "@/types/round-export-batch";

interface ContactCategoryLookup {
  id: string;
  category: string | null;
}

interface PlansAvailability {
  hasPlans: boolean;
  latestLabel: string | null;
}

interface SowAvailability {
  hasIssuedSow: boolean;
  latestLabel: string | null;
}

/** Local draft of a line's start/end date inputs, keyed by task id. Seeded from the task's own booking_date/booking_end_date when present; empty strings mean "type it in the panel" (BUILD-SPEC.md r24 item 2). */
interface DateDraft {
  start: string;
  end: string;
}

/**
 * Booking selection v2 (r24) — BUILD-SPEC.md §"Booking selection v2 +
 * Aria supplier invoices (r24)", items 1-4. REWORKS this panel's entry
 * points and eligibility rules on top of the r20 backend it keeps
 * unchanged (POST /api/projects/[id]/trade-requests — see that route's
 * own doc comment, not touched this round):
 *
 * - `seedTaskIds` replaces the old "always opens blank from the '•••'
 *   menu" shape. Two callers now (ProjectBoard.tsx):
 *     1. The board-wide selection action bar — "Book selected -> trade"
 *        — seedTaskIds is every checked row's task id, which may span
 *        more than one existing contact_id.
 *     2. A single item's "Book trade" button — seedTaskIds is that one
 *        task's id; once its own contact resolves, EVERY task on the
 *        project already linked to that same contact is pre-checked
 *        too (BUILD-SPEC.md item 3: "pre-listing ALL tasks ... mapped
 *        to that item's trade/contact (selected by default)").
 *   The old bare "•••" -> "Group book a trade…" entry point is REMOVED
 *   from ProjectBoard.tsx per item 3 ("replaced by these two entry
 *   points") — this panel is never opened with an empty seed in normal
 *   use any more, though an empty/all-mismatched seed still degrades
 *   gracefully to "pick a trade, nothing pre-checked" rather than
 *   erroring.
 *
 * - Undated tasks are NO LONGER excluded/greyed (BUILD-SPEC.md item 2:
 *   "no more pre-filling the board first, no more greyed-out
 *   exclusions"). Every task line for the chosen contact gets its own
 *   editable start/end date pair (`dateDrafts`), prefilled from
 *   booking_date/booking_end_date when set, blank otherwise. The ONE
 *   remaining hard exclusion is a task with no resolvable phase_id — a
 *   trade_visits row cannot exist without one (migration 016) — which
 *   is a real DB constraint, not a policy choice, so it stays greyed
 *   with its own explanation.
 *
 * - "+ Add more lines" (collapsed by default, BUILD-SPEC.md item 3)
 *   lists every OTHER eligible project task (any contact, including
 *   none) below the chosen contact's own list. Checking one of these
 *   REASSIGNS it to the panel's chosen contact on Send (along with
 *   whatever date it's given) — this is what actually lets "all the
 *   carpentry lines" collect into one request even when some of them
 *   never had a contact linked yet (this round's acceptance test).
 *
 * - Send does two existing-route calls, exactly as the outer task
 *   brief specifies: PATCH each changed task's works dates (and, for
 *   an "add more lines" reassignment, its contact_id) via the existing
 *   PATCH /api/board-tasks/[id] semantics, THEN POST
 *   /api/projects/[id]/trade-requests (r20, unchanged) to create the
 *   ONE trade_booking_request + ONE email. If a PATCH fails partway,
 *   the tasks patched so far already carry their new dates (visible on
 *   next refresh) even though the request itself doesn't get created —
 *   surfaced as an explicit error rather than silently retried, same
 *   "no partial silent state" discipline this codebase uses elsewhere
 *   (e.g. POST /api/invoices/[id]/approve's own doc comment).
 */
export function GroupBookPanel({
  projectId,
  seedTaskIds,
  onClose,
}: {
  projectId: string;
  /** Task ids to seed this panel's selection with — see this file's own header comment for the two calling shapes (multi-id "selected rows" vs single-id "per-item Book trade"). Omit/empty for a blank panel (contact picker only, nothing pre-checked). */
  seedTaskIds?: string[];
  onClose: () => void;
}) {
  const [contacts, setContacts] = useState<ContactPickerOption[]>([]);
  const [contactCategories, setContactCategories] = useState<ContactCategoryLookup[]>([]);
  const [allTasks, setAllTasks] = useState<GroupableTask[]>([]);
  const [presets, setPresets] = useState<ExportPresetRow[]>([]);
  const [plansAvailability, setPlansAvailability] = useState<PlansAvailability>({ hasPlans: false, latestLabel: null });
  const [sowAvailability, setSowAvailability] = useState<SowAvailability>({ hasIssuedSow: false, latestLabel: null });
  const [loading, setLoading] = useState(true);
  const [contactId, setContactId] = useState<string | null>(null);
  const [selectedTaskIds, setSelectedTaskIds] = useState<Set<string>>(new Set());
  const [dateDrafts, setDateDrafts] = useState<Map<string, DateDraft>>(new Map());
  const [defaultsAppliedForContact, setDefaultsAppliedForContact] = useState<string | null>(null);
  const [seedApplied, setSeedApplied] = useState(false);
  const [showMoreLines, setShowMoreLines] = useState(false);

  const [includePlans, setIncludePlans] = useState(false);
  const [includeSow, setIncludeSow] = useState(false);
  const [includeSchedule, setIncludeSchedule] = useState(false);
  const [scheduleCategories, setScheduleCategories] = useState<string[] | null>(null);
  const [schedulePresetName, setSchedulePresetName] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateTradeBookingRequestResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/contacts`).then((r) => (r.ok ? r.json() : { contacts: [] })),
      fetch(`/api/projects/${projectId}/board`).then((r) => (r.ok ? r.json() : { columns: [], groups: [] })),
      fetch(`/api/settings/export-presets`).then((r) => (r.ok ? r.json() : { presets: [] })),
      fetch(`/api/projects/${projectId}/files`).then((r) => (r.ok ? r.json() : { files: [] })),
      fetch(`/api/projects/${projectId}/sow`).then((r) => (r.ok ? r.json() : { sow_documents: [] })),
    ])
      .then(([contactsBody, boardBody, presetsBody, filesBody, sowBody]) => {
        if (cancelled) return;
        const rawContacts: (ContactPickerOption & { category?: string | null })[] = contactsBody.contacts ?? [];
        setContacts(rawContacts);
        setContactCategories(rawContacts.map((c) => ({ id: c.id, category: c.category ?? null })));
        setPresets(presetsBody.presets ?? []);

        type BoardTaskRow = {
          id: string;
          title: string;
          contact_id: string | null;
          booking_date: string | null;
          booking_end_date: string | null;
          phase_group_id: string | null;
          visit_id: string | null;
        };
        type BoardColumnRow = { tasks: BoardTaskRow[] };
        type BoardGroupRow = { id: string; phase_id: string | null };
        const columns: BoardColumnRow[] = boardBody.columns ?? [];
        const groups: BoardGroupRow[] = boardBody.groups ?? [];
        const phaseIdByGroup = new Map(groups.map((g) => [g.id, g.phase_id]));

        const flattened = columns.flatMap((c) => c.tasks ?? []);
        const uniqueById = new Map<string, BoardTaskRow>();
        for (const t of flattened) uniqueById.set(t.id, t);

        const tasks: GroupableTask[] = [...uniqueById.values()].map((t) => ({
          id: t.id,
          title: t.title,
          contact_id: t.contact_id,
          booking_date: t.booking_date,
          booking_end_date: t.booking_end_date,
          phase_group_id: t.phase_group_id,
          phase_id: t.phase_group_id ? phaseIdByGroup.get(t.phase_group_id) ?? null : null,
          visit_id: t.visit_id,
        }));
        setAllTasks(tasks);

        const plansFiles: { revision_label: string | null; uploaded_at: string; kind: string }[] =
          (filesBody.files ?? []).filter((f: { kind: string }) => f.kind === "plans");
        const latestPlans = [...plansFiles].sort((a, b) => {
          if (a.revision_label !== b.revision_label) {
            if (a.revision_label === null) return 1;
            if (b.revision_label === null) return -1;
            return b.revision_label.localeCompare(a.revision_label);
          }
          return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
        })[0];
        setPlansAvailability({ hasPlans: plansFiles.length > 0, latestLabel: latestPlans?.revision_label ?? null });

        const issuedSows: { revision_label: string; status: string; issued_at: string | null; created_at: string }[] =
          (sowBody.sow_documents ?? []).filter((s: { status: string }) => s.status === "issued");
        const latestSow = [...issuedSows].sort((a, b) => {
          const aTime = new Date(a.issued_at ?? a.created_at).getTime();
          const bTime = new Date(b.issued_at ?? b.created_at).getTime();
          return bTime - aTime;
        })[0];
        setSowAvailability({ hasIssuedSow: issuedSows.length > 0, latestLabel: latestSow?.revision_label ?? null });
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // ---- Seed resolution — runs once, as soon as allTasks has loaded.
  // Resolves the contact to prefill from the seeded task(s)' own
  // contact_id (most common one, ties broken by first-seen): a
  // single-item seed almost always has exactly one; a multi-select seed
  // from the action bar may span more than one existing contact, in
  // which case whichever contact most of the selection already shares
  // wins the prefill and the rest are simply left for "+ Add more
  // lines" (they're still real project tasks, just not pre-checked
  // under a contact they don't belong to) — see this file's own header
  // comment for why a per-task contact mismatch isn't silently forced. ----
  useEffect(() => {
    if (seedApplied || allTasks.length === 0) return;
    setSeedApplied(true);
    const ids = seedTaskIds ?? [];
    if (ids.length === 0) return;
    const seedTasks = allTasks.filter((t) => ids.includes(t.id));
    const counts = new Map<string, number>();
    for (const t of seedTasks) {
      if (t.contact_id) counts.set(t.contact_id, (counts.get(t.contact_id) ?? 0) + 1);
    }
    const resolved = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (resolved) setContactId(resolved);
  }, [allTasks, seedApplied, seedTaskIds]);

  const tasksForContact = useMemo(
    () => allTasks.filter((t) => t.contact_id === contactId),
    [allTasks, contactId]
  );
  // Board rows/phase-card rows without a resolvable phase_id can never
  // back a trade_visits row (migration 016) — the one exclusion this
  // round keeps, since it's a real schema constraint rather than a
  // "hasn't been dated yet" policy this round is explicitly reversing.
  const eligibleTasksForContact = useMemo(
    () => tasksForContact.filter((t) => t.phase_id),
    [tasksForContact]
  );
  const noPhaseTasksForContact = useMemo(
    () => tasksForContact.filter((t) => !t.phase_id),
    [tasksForContact]
  );
  // "+ Add more lines" — every other eligible project task, any contact
  // (including none), excluding whatever's already listed above for the
  // chosen contact. BUILD-SPEC.md item 3's "rest of the project's tasks
  // collapsibly addable" — checking one of these reassigns it to this
  // panel's contact on Send (see send() below).
  const otherEligibleTasks = useMemo(
    () => allTasks.filter((t) => t.contact_id !== contactId && t.phase_id),
    [allTasks, contactId]
  );

  const bookedTradeName = useMemo(() => {
    const contactCategory = contactId ? contactCategories.find((c) => c.id === contactId)?.category ?? null : null;
    return pickPresetForContactCategory(presets, contactCategory)?.name ?? null;
  }, [contactId, contactCategories, presets]);

  function draftFor(task: GroupableTask): DateDraft {
    return dateDrafts.get(task.id) ?? { start: task.booking_date ?? "", end: task.booking_end_date ?? "" };
  }
  function setDraft(taskId: string, patch: Partial<DateDraft>) {
    setDateDrafts((cur) => {
      const next = new Map(cur);
      const existing = next.get(taskId) ?? { start: "", end: "" };
      next.set(taskId, { ...existing, ...patch });
      return next;
    });
  }

  // Default selection on a (re)resolved contact — one-shot per contact,
  // same discipline as the r20 version of this effect. Single-item seed
  // (per-item "Book trade" — BUILD-SPEC.md item 3) checks EVERY eligible
  // task for that contact; a multi-id seed (action bar) checks only the
  // seeded ids that actually belong to this contact; no seed at all
  // (blank/manual contact pick) starts with nothing checked.
  useEffect(() => {
    if (!contactId || defaultsAppliedForContact === contactId) return;
    setDefaultsAppliedForContact(contactId);

    const ids = seedTaskIds ?? [];
    const eligibleIds = new Set(eligibleTasksForContact.map((t) => t.id));
    let initialSelection: Set<string>;
    if (ids.length === 1 && eligibleTasksForContact.some((t) => t.id === ids[0])) {
      initialSelection = new Set(eligibleIds);
    } else if (ids.length > 0) {
      initialSelection = new Set(ids.filter((id) => eligibleIds.has(id)));
    } else {
      initialSelection = new Set();
    }
    setSelectedTaskIds(initialSelection);

    // Seed the date drafts for every task now in view (checked or not)
    // from its own stored works dates, so the inputs show real values
    // immediately rather than flashing blank-then-filled.
    setDateDrafts((cur) => {
      const next = new Map(cur);
      for (const t of [...eligibleTasksForContact, ...otherEligibleTasks]) {
        if (!next.has(t.id)) next.set(t.id, { start: t.booking_date ?? "", end: t.booking_end_date ?? "" });
      }
      return next;
    });

    setIncludePlans(plansAvailability.hasPlans);
    setIncludeSow(sowAvailability.hasIssuedSow);
    setIncludeSchedule(true);
    const contactCategory = contactCategories.find((c) => c.id === contactId)?.category ?? null;
    const matched = pickPresetForContactCategory(presets, contactCategory);
    if (matched) {
      setScheduleCategories([...matched.prefixes]);
      setSchedulePresetName(matched.name);
    } else {
      setScheduleCategories(null);
      setSchedulePresetName(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId, eligibleTasksForContact, plansAvailability, sowAvailability, contactCategories, presets]);

  function toggleTask(taskId: string) {
    setSelectedTaskIds((cur) => {
      const next = new Set(cur);
      if (next.has(taskId)) next.delete(taskId);
      else {
        next.add(taskId);
        if (!dateDrafts.has(taskId)) {
          const task = allTasks.find((t) => t.id === taskId);
          setDraft(taskId, { start: task?.booking_date ?? "", end: task?.booking_end_date ?? "" });
        }
      }
      return next;
    });
  }

  async function send() {
    if (!contactId) {
      setError("Choose a trade first.");
      return;
    }
    const taskIds = [...selectedTaskIds];
    if (taskIds.length === 0) {
      setError("Select at least one task.");
      return;
    }
    // BUILD-SPEC.md r24 item 2 — every selected line needs both dates
    // before Send, whether they were already booked or just typed in
    // this panel; no more "undated lines silently excluded".
    const missingDates = taskIds.filter((id) => {
      const d = draftFor(allTasks.find((t) => t.id === id) ?? ({ id, booking_date: null, booking_end_date: null } as GroupableTask));
      return !d.start || !d.end;
    });
    if (missingDates.length > 0) {
      setError("Every selected line needs a start and end date — type them in above.");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      // 1. Write back changed works dates (placeholders) and, for a
      // task picked up via "+ Add more lines" under a different (or no)
      // contact, its new contact_id — via the EXISTING PATCH
      // /api/board-tasks/[id] route/semantics (Board v3.3's
      // booking_date/booking_end_date whitelist), never a new route.
      for (const id of taskIds) {
        const task = allTasks.find((t) => t.id === id);
        const draft = draftFor(task ?? ({ id, booking_date: null, booking_end_date: null } as GroupableTask));
        const patch: Record<string, unknown> = {};
        if (!task || task.booking_date !== draft.start) patch.booking_date = draft.start;
        if (!task || task.booking_end_date !== draft.end) patch.booking_end_date = draft.end;
        if (task && task.contact_id !== contactId) patch.contact_id = contactId;
        if (Object.keys(patch).length > 0) {
          const patchRes = await fetch(`/api/board-tasks/${id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (!patchRes.ok) {
            const body = await patchRes.json().catch(() => ({}));
            throw new Error(body.error ?? `Could not save the works dates for "${task?.title ?? id}".`);
          }
        }
      }

      // 2. r20, unchanged — ONE trade_booking_request + ONE email.
      const anyIncluded = includePlans || includeSchedule || includeSow;
      const documentPack: DocumentPackChoices | undefined = anyIncluded
        ? {
            include_plans: includePlans,
            ...(includeSchedule ? { schedule_categories: scheduleCategories } : {}),
            include_sow: includeSow,
            include_sow_trade: includeSow ? bookedTradeName : null,
          }
        : undefined;
      const res = await fetch(`/api/projects/${projectId}/trade-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact_id: contactId, task_ids: taskIds, document_pack: documentPack }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not send the request.");
      setResult(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the request.");
    } finally {
      setSaving(false);
    }
  }

  function TaskRow({ task }: { task: GroupableTask }) {
    const draft = draftFor(task);
    const checked = selectedTaskIds.has(task.id);
    return (
      <div className="flex flex-wrap items-center gap-2 border-b border-[#e5e0d6] py-1.5 last:border-b-0">
        <label className="flex flex-1 items-center gap-2 text-body text-charcoal">
          <input
            type="checkbox"
            checked={checked}
            onChange={() => toggleTask(task.id)}
            className="h-3.5 w-3.5 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate">{task.title}</span>
          {task.visit_id && (
            <span className="shrink-0 text-caption text-charcoal/40" title="Already linked to a booked visit">
              already linked
            </span>
          )}
        </label>
        <div className="flex shrink-0 items-center gap-1">
          <input
            type="date"
            value={draft.start}
            onChange={(e) => setDraft(task.id, { start: e.target.value })}
            className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-0.5 text-caption focus:border-nearblack focus:outline-none"
          />
          <span className="text-caption text-charcoal/40">→</span>
          <input
            type="date"
            value={draft.end}
            onChange={(e) => setDraft(task.id, { end: e.target.value })}
            className="border border-[#c9c2b4] bg-nearwhite px-1.5 py-0.5 text-caption focus:border-nearblack focus:outline-none"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-lg overflow-y-auto border border-[#dcd6cc] bg-cream p-5"
      >
        <div className="flex items-center justify-between">
          <p className="label-caps">Book a trade</p>
          <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close
          </button>
        </div>

        {result ? (
          <div className="mt-3 space-y-2">
            <p className="border border-sand bg-cream px-3 py-2 text-body text-charcoal">
              {result.email_sent
                ? `Request sent to ${contacts.find((c) => c.id === contactId)?.company ?? "the trade"} — ${result.visit_ids.length} line${result.visit_ids.length === 1 ? "" : "s"}.`
                : `Request created (${result.visit_ids.length} line${result.visit_ids.length === 1 ? "" : "s"}) — email not sent: ${result.email_skip_reason ?? "unknown reason"}.`}
            </p>
            {result.skipped.length > 0 && (
              <p className="border border-[#dcd6cc] bg-nearwhite px-3 py-2 text-caption text-charcoal/70">
                {result.skipped.length} task{result.skipped.length === 1 ? "" : "s"} skipped (already in an open request, or not found).
              </p>
            )}
            <button type="button" onClick={onClose} className="w-full bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal">
              Close
            </button>
          </div>
        ) : loading ? (
          <p className="mt-3 text-body text-charcoal/50">Loading…</p>
        ) : (
          <div className="mt-3 space-y-3">
            <label className="block">
              <span className="label-caps mb-1 block">Trade</span>
              <ContactPicker contacts={contacts} selectedId={contactId} onSelect={setContactId} placeholder="Select a trade…" />
            </label>

            {contactId && (
              <>
                {tasksForContact.length === 0 ? (
                  <p className="border border-[#dcd6cc] bg-offwhite px-3 py-2 text-body text-charcoal/60">
                    No tasks on this project are assigned to this trade yet — use &quot;+ Add more lines&quot; below to add some.
                  </p>
                ) : (
                  <div className="space-y-0.5 border border-[#dcd6cc] bg-offwhite px-3 py-2.5">
                    <p className="label-caps">Tasks — every line gets a start and end date</p>
                    {eligibleTasksForContact.map((t) => (
                      <TaskRow key={t.id} task={t} />
                    ))}
                    {noPhaseTasksForContact.length > 0 && (
                      <p className="pt-1 text-caption text-charcoal/40">
                        {noPhaseTasksForContact.length} task{noPhaseTasksForContact.length === 1 ? "" : "s"} not shown — no phase set (link a phase on the board first).
                      </p>
                    )}
                  </div>
                )}

                <div className="border border-[#dcd6cc] bg-offwhite">
                  <button
                    type="button"
                    onClick={() => setShowMoreLines((v) => !v)}
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-caption text-charcoal/70 hover:text-nearblack"
                  >
                    <span>+ Add more lines from this project</span>
                    <span>{showMoreLines ? "▴" : "▾"}</span>
                  </button>
                  {showMoreLines && (
                    <div className="space-y-0.5 border-t border-[#dcd6cc] px-3 py-2.5">
                      {otherEligibleTasks.length === 0 ? (
                        <p className="text-caption text-charcoal/50">Nothing else eligible on this project.</p>
                      ) : (
                        otherEligibleTasks.map((t) => {
                          const currentContact = t.contact_id ? contacts.find((c) => c.id === t.contact_id) : null;
                          return (
                            <div key={t.id}>
                              <TaskRow task={t} />
                              <p className="pl-6 pb-1 text-caption text-charcoal/40">
                                {currentContact
                                  ? `Currently linked to ${currentContact.company} — checking this reassigns it to the trade above on Send.`
                                  : "No trade linked yet — checking this assigns it to the trade above on Send."}
                              </p>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 border border-[#dcd6cc] bg-offwhite px-3 py-2.5">
                  <p className="label-caps">Include documents</p>
                  <label className="flex items-center gap-2 text-body text-charcoal">
                    <input type="checkbox" checked={includePlans} onChange={(e) => setIncludePlans(e.target.checked)} className="h-3.5 w-3.5" />
                    <span>Plans{plansAvailability.hasPlans ? "" : <span className="text-charcoal/40"> — none uploaded yet</span>}</span>
                  </label>
                  <label className="flex items-center gap-2 text-body text-charcoal">
                    <input type="checkbox" checked={includeSchedule} onChange={(e) => setIncludeSchedule(e.target.checked)} className="h-3.5 w-3.5" />
                    <span>{scheduleLabel(scheduleCategories, schedulePresetName)}</span>
                  </label>
                  <label className="flex items-center gap-2 text-body text-charcoal">
                    <input type="checkbox" checked={includeSow} onChange={(e) => setIncludeSow(e.target.checked)} className="h-3.5 w-3.5" />
                    <span>Scope of Works{sowAvailability.hasIssuedSow ? "" : <span className="text-charcoal/40"> — none issued yet</span>}</span>
                  </label>
                </div>
              </>
            )}

            {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

            <button
              type="button"
              onClick={send}
              disabled={saving || !contactId}
              className="w-full bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {saving ? "Sending…" : "Send request"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
