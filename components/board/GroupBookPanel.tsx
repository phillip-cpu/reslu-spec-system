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

/**
 * Grouped trade booking round (r20) — "group mode" sibling to
 * BookVisitPanel.tsx (BUILD-SPEC.md item 2: "extend BookVisitPanel...
 * or add a sibling GroupBookPanel launched from the same place — pick
 * whichever disturbs existing code less"). Built as a fully
 * self-sufficient sibling rather than extending BookVisitPanel itself:
 * that component's whole shape (a SINGLE phase/trade/date-range form,
 * opened FROM one specific card with card-context prefill) is a
 * fundamentally different flow from "pick a trade first, THEN see
 * every one of their tasks" — bolting a second mode onto its already
 * dense state machine (phaseLocked/cardContext/booked/etc., see that
 * file's own header comment) would have been the riskier edit to an
 * already-large, already-tested component. This file owns its own
 * entry point instead (ProjectBoard.tsx's "•••" board-actions menu —
 * see that file's own doc comment at the call site), disturbing zero
 * of BookVisitPanel's existing code.
 *
 * Reuses the SAME "Include documents" machinery (lib/trade-doc-pack.ts,
 * lib/export-presets.ts, types/trade-doc-pack.ts) BookVisitPanel
 * already established — one shared pack, frozen identically onto every
 * selected task's line at send time (BUILD-SPEC.md item 2).
 *
 * Task list source: GET /api/projects/[id]/board's EXISTING response
 * (no new GET route this round) — flattens every column's tasks,
 * filters to the picked contact, and resolves each task's phase_id via
 * the matching board_groups row (needed because a trade_visits row
 * cannot exist without a phase_id — see migration 016). A task with no
 * booking_date/booking_end_date, or whose group has no linked phase,
 * is shown GREYED and excluded from selection (BUILD-SPEC.md item 2:
 * "undated tasks shown greyed/excluded") — the "no phase" exclusion is
 * this round's own necessary extension of that same rule.
 */
export function GroupBookPanel({
  projectId,
  onClose,
}: {
  projectId: string;
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
  const [defaultsAppliedForContact, setDefaultsAppliedForContact] = useState<string | null>(null);

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

  const tasksForContact = useMemo(
    () => allTasks.filter((t) => t.contact_id === contactId),
    [allTasks, contactId]
  );
  const eligibleTasksForContact = useMemo(
    () => tasksForContact.filter((t) => t.booking_date && t.booking_end_date && t.phase_id),
    [tasksForContact]
  );

  // Same "own memo, not schedulePresetName" discipline as
  // BookVisitPanel's bookedTradeName — include_sow_trade freezes WHICH
  // trade's extract to prefer, independent of whatever a staff member
  // has since changed the Schedule row's own preset to.
  const bookedTradeName = useMemo(() => {
    const contactCategory = contactId ? contactCategories.find((c) => c.id === contactId)?.category ?? null : null;
    return pickPresetForContactCategory(presets, contactCategory)?.name ?? null;
  }, [contactId, contactCategories, presets]);

  // Default: every ELIGIBLE task for the newly-picked contact starts
  // checked (BUILD-SPEC.md item 2: "checkbox-selected, default all
  // checked") — runs once per contact change, guarded by
  // defaultsAppliedForContact so a staff member's own subsequent
  // unticks are never fought, same one-shot-default discipline
  // BookVisitPanel's own "Include documents" defaults effect uses.
  useEffect(() => {
    if (!contactId || defaultsAppliedForContact === contactId) return;
    setDefaultsAppliedForContact(contactId);
    setSelectedTaskIds(new Set(eligibleTasksForContact.map((t) => t.id)));

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
      else next.add(taskId);
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
      setError("Select at least one task with a proposed date.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const anyIncluded = includePlans || includeSchedule || includeSow;
      const documentPack: DocumentPackChoices | undefined = anyIncluded
        ? {
            include_plans: includePlans,
            ...(includeSchedule ? { schedule_categories: scheduleCategories } : {}),
            include_sow: includeSow,
            // Required field (types/trade-doc-pack.ts) — see
            // bookedTradeName's own comment above for why this is its
            // own memo, not schedulePresetName.
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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="max-h-[85vh] w-full max-w-md overflow-y-auto border border-[#dcd6cc] bg-cream p-5"
      >
        <div className="flex items-center justify-between">
          <p className="label-caps">Group book a trade</p>
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
                {result.skipped.length} task{result.skipped.length === 1 ? "" : "s"} skipped (no dates or no phase set).
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
                    No tasks on this project are assigned to this trade yet.
                  </p>
                ) : (
                  <div className="space-y-1 border border-[#dcd6cc] bg-offwhite px-3 py-2.5">
                    <p className="label-caps">Tasks</p>
                    {tasksForContact.map((t) => {
                      const eligible = !!(t.booking_date && t.booking_end_date && t.phase_id);
                      const dateLabel =
                        t.booking_date && t.booking_end_date
                          ? t.booking_date === t.booking_end_date
                            ? t.booking_date
                            : `${t.booking_date} → ${t.booking_end_date}`
                          : "No date set";
                      return (
                        <label
                          key={t.id}
                          className={`flex items-center gap-2 py-1 text-body ${eligible ? "text-charcoal" : "text-charcoal/35"}`}
                        >
                          <input
                            type="checkbox"
                            disabled={!eligible}
                            checked={eligible && selectedTaskIds.has(t.id)}
                            onChange={() => toggleTask(t.id)}
                            className="h-3.5 w-3.5"
                          />
                          <span className="flex-1 truncate">{t.title}</span>
                          <span className="shrink-0 text-caption">
                            {dateLabel}
                            {eligible && !t.phase_id ? " (no phase)" : !eligible && t.booking_date ? " (no phase)" : ""}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}

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
