"use client";

import { useEffect, useMemo, useState } from "react";
import type { ContactPickerOption } from "@/types/board-cockpit";
import type { BookVisitPanelCardContext } from "@/types/board-v3-3";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";
import { ContactPicker } from "@/components/shared/ContactPicker";
import { pickPresetForContactCategory } from "@/lib/export-presets";
import { scheduleLabel } from "@/lib/trade-doc-pack";
import type { ExportPresetRow } from "@/types/round-export-batch";

interface PhaseOption {
  id: string;
  name: string;
  kind: "phase" | "umbrella";
}

const EMAIL_SKIP_REASON_LABEL: Record<string, string> = {
  no_gmail_config: "email not configured",
  no_contact: "no trade linked",
  no_contact_email: "trade has no email on file",
};

/** Minimal shape this panel reads off the raw GET /api/contacts response for the Schedule auto-pick — that route does `select("*")`, so `category` is already present in the JSON even though the shared ContactPickerOption type (types/board-cockpit.ts, not edited by this round) doesn't declare it. Kept local rather than widening ContactPickerOption, which is a cross-cutting shared type used by four other pickers that have no need for this field. */
interface ContactCategoryLookup {
  id: string;
  category: string | null;
}

/** Minimal project_files row shape this panel needs for the Plans availability check — see GET /api/projects/[id]/files's response shape. */
interface PlansAvailability {
  hasPlans: boolean;
  latestLabel: string | null;
}

/** Minimal sow_documents row shape this panel needs for the SOW availability check — see GET /api/projects/[id]/sow's response shape. */
interface SowAvailability {
  hasIssuedSow: boolean;
  latestLabel: string | null;
}

/**
 * Book-trade-from-card popover — Board cockpit round (7 July 2026)
 * "Book-trade-from-card with visit_id linkage + live status badge."
 * Opened from a BoardCard's "Book trade" action (components/board/
 * ProjectBoard.tsx's BoardCard). Fetches this project's phases on open
 * (needed for the phase picker — a visit must belong to a phase, same
 * requirement POST /api/projects/[id]/visits already has) and contacts
 * (for the trade picker, via the shared ContactPicker) lazily, so a
 * card that never books a trade pays zero extra cost for this feature.
 *
 * Deliberately its own small file (not inlined into ProjectBoard.tsx,
 * which is already large) — mirrors how components/gantt/
 * VisitBottomSheet.tsx is its own file alongside GanttChart.tsx for the
 * same "large parent file, small focused popover" reason.
 *
 * Prefill fix (Two more — 7 July 2026 evening): opening this panel FROM
 * a card arrived with phase/trade/dates all blank on every surface
 * (desktop kanban card, Stacked kanban section, Grouped-list row —
 * they all funnel into this one shared panel). Root cause was here:
 * this component's prop interface never accepted the card's own
 * context in the first place — its four form fields always
 * initialized blank regardless of which card opened it. Fixed by
 * accepting optional `initial*` props, used as this component's
 * `useState` initializers below. No `useEffect` re-sync is needed:
 * ProjectBoard.tsx only ever mounts one of these at a time
 * (`{bookingPrefill && <BookVisitPanel .../>}`) and fully unmounts it
 * on close, so a fresh mount (with fresh initial props) happens every
 * time a different card's "Book trade" is clicked — initializer-only
 * state is sufficient and matches every other one-shot popover in this
 * file's own codebase (e.g. GroupPhaseDateInputs is the one exception
 * that stays mounted across prop changes, hence its own useEffect
 * resync — not the situation here). All prefilled values remain
 * plain, editable controlled inputs — nothing here is read-only/locked
 * — satisfying "prefilled values remain editable before submit."
 *
 * Board v3.3 — item 3 "Prefill re-verification": traced every opener of
 * this panel (BoardCard, StackedColumnSection's rows via
 * BoardTaskEditorBody, GroupTable/GroupRows, UngroupedTable) and found
 * every one of them ALREADY passes the full BoardTaskV3 through to
 * ProjectBoard's `bookingTask` state and on into `initialPhaseId`/
 * `initialContactId`/`initialStartDate`/`initialEndDate` above — the
 * prior "Two more" round's prefill fix (see this file's own doc comment
 * above) was itself correct and is still in effect; no opener currently
 * drops the context. What WAS still true, and is fixed here: the panel
 * gave no VISIBLE signal that it had arrived with card context at all —
 * a blank-looking phase select and a pre-filled one look identical at a
 * glance, which is exactly the ambiguity Phillip's 00:21 screenshot
 * report was really describing (whether a genuinely-blank field is a
 * dropped-context bug or just an unphased/unphased-contact card is
 * impossible to tell without this line). `cardContext` (optional — the
 * generic/no-card entry points, if any are ever added, simply omit it)
 * renders a subtle "From: {title}" trace line so the prefilled state is
 * visible, and locks the phase select (with its own small "Change"
 * affordance — see the `phaseLocked` state below) since a card opened
 * from a specific phase group's row should not silently let a booking
 * land in a different phase without a deliberate, visible action first.
 */
export function BookVisitPanel({
  projectId,
  initialPhaseId,
  initialContactId,
  initialStartDate,
  initialEndDate,
  cardContext,
  onBook,
  onClose,
}: {
  projectId: string;
  /** Preselects the phase dropdown — resolved by the caller from the card's phase_group_id (a board_groups.id) via the matching group's own phase_id (a schedule_phases.id, same id space this panel's phase options use). Omit/null for a blank start (e.g. a generic/unphased booking entry point). */
  initialPhaseId?: string | null;
  /** Preselects the trade (contact) picker — the card's own contact_id. */
  initialContactId?: string | null;
  /** Preselects the Start date input — the card's booking_date, if it already had one (e.g. re-booking after an unlink). */
  initialStartDate?: string | null;
  /** Preselects the End date input — the card's booking_end_date. */
  initialEndDate?: string | null;
  /** Board v3.3 — present whenever this panel was opened FROM a card (every current entry point) — see this component's own doc comment for the "From: {title}" trace line + phase-lock this drives. Omitted only for a hypothetical future generic/no-card entry point. */
  cardContext?: BookVisitPanelCardContext;
  onBook: (input: {
    phase_id: string;
    contact_id?: string | null;
    start_date: string;
    end_date: string;
    document_pack?: DocumentPackChoices;
  }) => Promise<{ insuranceWarning: string | null; emailSent: boolean; emailSkipReason?: string }>;
  onClose: () => void;
}) {
  const [phases, setPhases] = useState<PhaseOption[]>([]);
  const [contacts, setContacts] = useState<ContactPickerOption[]>([]);
  const [contactCategories, setContactCategories] = useState<ContactCategoryLookup[]>([]);
  const [presets, setPresets] = useState<ExportPresetRow[]>([]);
  const [plansAvailability, setPlansAvailability] = useState<PlansAvailability>({ hasPlans: false, latestLabel: null });
  const [sowAvailability, setSowAvailability] = useState<SowAvailability>({ hasIssuedSow: false, latestLabel: null });
  const [loading, setLoading] = useState(true);
  const [phaseId, setPhaseId] = useState(initialPhaseId ?? "");
  const [contactId, setContactId] = useState<string | null>(initialContactId ?? null);
  const [startDate, setStartDate] = useState(initialStartDate ?? "");
  const [endDate, setEndDate] = useState(initialEndDate ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ------------------------------------------------------------
  // "Trade booking document pack" round — "Include documents" section
  // state. Three independent choices, each defaulting ON when the
  // corresponding document is available (BUILD-SPEC.md item 2:
  // "Plans ON if any project_files kind plans exist ... Schedule ON
  // with auto-picked preset ... SOW ON if an issued sow_documents
  // revision exists") — see the availability-driven default effect
  // below, which runs once per relevant data change and only ever
  // turns a choice ON from its initial false, never fighting a staff
  // member's own subsequent untick (guarded by the `defaultsApplied`
  // ref-like boolean state so it runs at most once per panel mount,
  // same one-shot-initializer spirit as this component's own header
  // comment describes for initial*/cardContext prefill).
  // ------------------------------------------------------------
  const [includePlans, setIncludePlans] = useState(false);
  const [includeSow, setIncludeSow] = useState(false);
  const [includeSchedule, setIncludeSchedule] = useState(false);
  // null = full schedule (every category); a non-null array is either
  // an auto-picked preset's prefixes or a hand-edited custom selection
  // — schedulePresetName tracks ONLY whether the current categories
  // came from a named preset, purely for display ("Your schedule —
  // Plumber" vs "— Custom" vs "— Full schedule").
  const [scheduleCategories, setScheduleCategories] = useState<string[] | null>(null);
  const [schedulePresetName, setSchedulePresetName] = useState<string | null>(null);
  const [scheduleChangeOpen, setScheduleChangeOpen] = useState(false);
  const [defaultsApplied, setDefaultsApplied] = useState(false);
  // Non-blocking trade-insurance warning — same check every other
  // booking path in the app surfaces. The visit is already booked by
  // the time this renders, so it doesn't block anything; it just keeps
  // the panel open (instead of auto-closing) so the warning is seen.
  const [insuranceWarning, setInsuranceWarning] = useState<string | null>(null);
  // Board v3.3 — item 2: the email outcome from a successful booking,
  // shown alongside (or instead of) the insurance warning on success —
  // see the success-state JSX below for how the two combine.
  const [emailOutcome, setEmailOutcome] = useState<{ sent: boolean; skipReason?: string } | null>(null);
  const [booked, setBooked] = useState(false);
  // Board v3.3 — item 3: the phase select starts LOCKED (a quiet
  // read-only chip, not a <select>) whenever this panel arrived with
  // card context AND a resolved initial phase — a card opened from a
  // specific phase group's row should not silently let its booking land
  // in a different phase without a deliberate "Change" click first.
  // Starts unlocked (a normal, always-editable <select>) when there's
  // no card context, or the card had no phase yet (nothing to protect
  // against accidentally changing). Judged safer than a hard lock with
  // no escape hatch — the trade itself is still selected fresh every
  // time (contact_id is never "sticky" the same way), so only the
  // phase gets this extra guard, since a phase mismatch is the specific
  // failure mode BUILD-SPEC.md's screenshot report was about.
  const [phaseLocked, setPhaseLocked] = useState(!!cardContext && !!initialPhaseId);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects/${projectId}/phases`).then((r) => (r.ok ? r.json() : { phases: [] })),
      fetch(`/api/contacts`).then((r) => (r.ok ? r.json() : { contacts: [] })),
      // "Trade booking document pack" — three more fetches, all
      // lightweight and all needed up-front so the "Include documents"
      // section can render its availability-aware defaults the moment
      // loading finishes, with no extra per-checkbox spinner. Each
      // tolerates its own failure independently (same `.catch(() =>
      // ({...}))` per-promise pattern already used for phases/contacts
      // above via the `r.ok ? r.json() : {...}` fallback) so e.g. a
      // Settings misconfiguration on export presets can never block
      // the rest of the panel from opening.
      fetch(`/api/settings/export-presets`).then((r) => (r.ok ? r.json() : { presets: [] })),
      fetch(`/api/projects/${projectId}/files`).then((r) => (r.ok ? r.json() : { files: [] })),
      fetch(`/api/projects/${projectId}/sow`).then((r) => (r.ok ? r.json() : { sow_documents: [] })),
    ])
      .then(([phasesBody, contactsBody, presetsBody, filesBody, sowBody]) => {
        if (cancelled) return;
        const nonUmbrella = (phasesBody.phases ?? []).filter((p: PhaseOption) => p.kind !== "umbrella");
        setPhases(nonUmbrella);
        const rawContacts: (ContactPickerOption & { category?: string | null })[] = contactsBody.contacts ?? [];
        setContacts(rawContacts);
        setContactCategories(rawContacts.map((c) => ({ id: c.id, category: c.category ?? null })));
        setPresets(presetsBody.presets ?? []);

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
        setPlansAvailability({
          hasPlans: plansFiles.length > 0,
          latestLabel: latestPlans?.revision_label ?? null,
        });

        const issuedSows: { revision_label: string; status: string; issued_at: string | null; created_at: string }[] =
          (sowBody.sow_documents ?? []).filter((s: { status: string }) => s.status === "issued");
        const latestSow = [...issuedSows].sort((a, b) => {
          const aTime = new Date(a.issued_at ?? a.created_at).getTime();
          const bTime = new Date(b.issued_at ?? b.created_at).getTime();
          return bTime - aTime;
        })[0];
        setSowAvailability({
          hasIssuedSow: issuedSows.length > 0,
          latestLabel: latestSow?.revision_label ?? null,
        });
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  /**
   * Availability-aware defaults (BUILD-SPEC.md item 2) — runs exactly
   * ONCE, the first time all the data it needs has arrived (guarded by
   * `defaultsApplied`), so a staff member's own subsequent unticking of
   * a checkbox is never fought/reset by this effect re-running on an
   * unrelated state change (e.g. picking a different contact
   * afterwards does NOT re-run the Schedule auto-pick out from under
   * an already-open panel — see the Schedule "change" affordance below
   * for the one deliberate exception, a manual re-pick the staff member
   * explicitly asked for).
   */
  useEffect(() => {
    if (defaultsApplied || loading) return;
    setDefaultsApplied(true);

    if (plansAvailability.hasPlans) setIncludePlans(true);
    if (sowAvailability.hasIssuedSow) setIncludeSow(true);

    // Schedule auto-pick: match the currently-selected contact's
    // category against presets (case-insensitive containment), else
    // name-heuristic, else full schedule — see
    // lib/export-presets.ts's pickPresetForContactCategory(). Schedule
    // itself defaults ON regardless of which of the three outcomes
    // applies (BUILD-SPEC's wording: "Schedule ON with auto-picked
    // preset ... else full schedule" — "else full schedule" is a
    // fallback for WHICH categories, not a reason to leave the row
    // unticked).
    setIncludeSchedule(true);
    const contactCategory = contactId ? contactCategories.find((c) => c.id === contactId)?.category ?? null : null;
    const matched = pickPresetForContactCategory(presets, contactCategory);
    if (matched) {
      setScheduleCategories([...matched.prefixes]);
      setSchedulePresetName(matched.name);
    } else {
      setScheduleCategories(null);
      setSchedulePresetName(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, defaultsApplied]);

  /** All export-preset names, for the Schedule "change" select — includes a synthetic "Full schedule" option (categories: null) at the top, same convention as ExportDialog's own "all ticked = full schedule" default. */
  const schedulePickOptions = useMemo(
    () => [{ name: "Full schedule", categories: null as string[] | null }, ...presets.map((p) => ({ name: p.name, categories: p.prefixes }))],
    [presets]
  );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!phaseId || !startDate || !endDate) {
      setError("Phase, start date, and end date are required.");
      return;
    }
    if (endDate < startDate) {
      setError("End date must be on or after the start date.");
      return;
    }
    setSaving(true);
    setError(null);
    setInsuranceWarning(null);
    setEmailOutcome(null);
    try {
      // "Trade booking document pack" — freeze the panel's three
      // "Include documents" choices into the shape migration 032's
      // trade_visits.document_pack expects.
      //
      // schedule_categories uses KEY PRESENCE (not null) to encode
      // "Schedule ticked at all" — see DocumentPackChoices' own doc
      // comment for the full three-state rationale: omitting the key
      // entirely means "Schedule unticked," `null` means "Schedule
      // ticked, full schedule," and an array means "Schedule ticked,
      // filtered." Built via conditional spread rather than a ternary
      // assigning `null`, which would have collapsed "unticked" and
      // "ticked + full schedule" into the same wire value — exactly the
      // bug this component's own design review caught.
      //
      // The whole `document_pack` field is omitted (not an all-false
      // object) when none of the three is ticked — a project with
      // genuinely nothing to pack doesn't grow a document_pack column
      // for no reason; see POST /api/board-tasks/[id]/book-visit's own
      // doc comment for why an omitted field (not null) is what that
      // route's document_pack handling expects for "nothing to store."
      const anyIncluded = includePlans || includeSchedule || includeSow;
      const documentPack: DocumentPackChoices | undefined = anyIncluded
        ? {
            include_plans: includePlans,
            ...(includeSchedule ? { schedule_categories: scheduleCategories } : {}),
            include_sow: includeSow,
          }
        : undefined;
      const result = await onBook({
        phase_id: phaseId,
        contact_id: contactId,
        start_date: startDate,
        end_date: endDate,
        document_pack: documentPack,
      });
      // Board v3.3 — item 2: unlike the insurance warning (which used
      // to be the ONLY reason this panel stayed open after a successful
      // book), the email outcome is ALWAYS shown on success — a plain
      // "request sent" confirmation is just as useful a signal as a
      // skip reason, so `booked` (not just "insuranceWarning present")
      // now gates the success view.
      setEmailOutcome({ sent: result.emailSent, skipReason: result.emailSkipReason });
      setInsuranceWarning(result.insuranceWarning);
      setBooked(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not book the visit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm space-y-3 border border-[#dcd6cc] bg-cream p-5"
      >
        <div className="flex items-center justify-between">
          <p className="label-caps">Book a trade visit</p>
          <button type="button" onClick={onClose} className="text-caption text-charcoal/50 hover:text-nearblack">
            Close
          </button>
        </div>

        {/* Board v3.3 — item 3: visible prefill trace. Shown whenever
            this panel was opened from a card, regardless of whether
            booked/still-editing, so it's never ambiguous whether the
            fields above came from somewhere or are a coincidence. */}
        {cardContext && (
          <p className="text-caption text-charcoal/50">From: {cardContext.title}</p>
        )}

        {booked ? (
          // Already booked by this point (onBook succeeded) — both the
          // insurance warning and the email outcome are informational,
          // not a reason to keep the form editable/re-submittable. Same
          // non-blocking spirit as AddVisitForm/VisitBottomSheet's own
          // insurance warnings.
          <>
            <p className="border border-sand bg-cream px-2 py-1.5 text-caption text-charcoal">
              Visit booked.
              {insuranceWarning ? ` ${insuranceWarning}` : ""}
            </p>
            {/* Board v3.3 — item 2: "request sent to {contact}" vs.
                "booked — email not sent: {reason}" — surfaced right
                alongside the booking confirmation, not a separate toast,
                so it's still visible if the panel is left open a moment
                (e.g. reading the insurance warning above it). */}
            <p className="border border-[#dcd6cc] bg-nearwhite px-2 py-1.5 text-caption text-charcoal/70">
              {emailOutcome?.sent
                ? `Request sent to ${contacts.find((c) => c.id === contactId)?.company ?? "the trade"}.`
                : `Email not sent: ${EMAIL_SKIP_REASON_LABEL[emailOutcome?.skipReason ?? ""] ?? "unknown reason"}.`}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
            >
              Close
            </button>
          </>
        ) : (
          <>
            {loading ? (
              <p className="text-body text-charcoal/50">Loading…</p>
            ) : (
              <>
                <label className="block">
                  <span className="label-caps mb-1 block">Phase</span>
                  {/* Board v3.3 — item 3: locked to a quiet read-only
                      chip (see phaseLocked's own doc comment above for
                      why only the phase gets this guard) with a small
                      "Change" affordance that swaps in the ordinary
                      <select> below — never a hard, permanent lock. */}
                  {phaseLocked ? (
                    <div className="flex items-center justify-between border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body text-charcoal">
                      <span>{phases.find((p) => p.id === phaseId)?.name ?? "…"}</span>
                      <button
                        type="button"
                        onClick={() => setPhaseLocked(false)}
                        className="text-caption text-charcoal/50 underline hover:text-nearblack"
                      >
                        Change
                      </button>
                    </div>
                  ) : (
                    <select
                      value={phaseId}
                      onChange={(e) => setPhaseId(e.target.value)}
                      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                    >
                      <option value="">Select a phase…</option>
                      {phases.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  )}
                </label>

                <label className="block">
                  <span className="label-caps mb-1 block">Trade</span>
                  <ContactPicker contacts={contacts} selectedId={contactId} onSelect={setContactId} placeholder="Select a trade…" />
                </label>

                <div className="flex gap-2">
                  <label className="flex-1">
                    <span className="label-caps mb-1 block">Start</span>
                    <input
                      type="date"
                      value={startDate}
                      onChange={(e) => {
                  const v = e.target.value;
                  setStartDate(v);
                  // Phillip 8 Jul: picking a start snaps the end field to
                  // the same date when empty/earlier — no month-flicking.
                  if (v && (!endDate || endDate < v)) setEndDate(v);
                }}
                      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                    />
                  </label>
                  <label className="flex-1">
                    <span className="label-caps mb-1 block">End</span>
                    <input
                      type="date"
                      value={endDate}
                      onChange={(e) => setEndDate(e.target.value)}
                      className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
                    />
                  </label>
                </div>

                {/* "Trade booking document pack" — item 2's "Include
                    documents" section. Availability-aware defaults are
                    applied once by the effect above; every checkbox
                    here stays a plain, always-editable control — a
                    staff member can untick anything the defaults
                    turned on, or tick something that had no
                    availability-driven default at all. */}
                <div className="space-y-1.5 border border-[#dcd6cc] bg-offwhite px-3 py-2.5">
                  <p className="label-caps">Include documents</p>

                  <label className="flex items-center gap-2 text-body text-charcoal">
                    <input
                      type="checkbox"
                      checked={includePlans}
                      onChange={(e) => setIncludePlans(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>
                      Plans
                      {plansAvailability.hasPlans ? (
                        plansAvailability.latestLabel ? ` (${plansAvailability.latestLabel})` : " (latest)"
                      ) : (
                        <span className="text-charcoal/40"> — none uploaded yet</span>
                      )}
                    </span>
                  </label>

                  <div className="flex items-center gap-2 text-body text-charcoal">
                    <input
                      type="checkbox"
                      checked={includeSchedule}
                      onChange={(e) => setIncludeSchedule(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="flex-1">{scheduleLabel(scheduleCategories, schedulePresetName)}</span>
                    {includeSchedule && (
                      <button
                        type="button"
                        onClick={() => setScheduleChangeOpen((o) => !o)}
                        className="text-caption text-charcoal/50 underline hover:text-nearblack"
                      >
                        Change
                      </button>
                    )}
                  </div>
                  {includeSchedule && scheduleChangeOpen && (
                    <select
                      value={schedulePresetName ?? (scheduleCategories === null ? "Full schedule" : "__custom__")}
                      onChange={(e) => {
                        const picked = schedulePickOptions.find((o) => o.name === e.target.value);
                        if (!picked) return;
                        setScheduleCategories(picked.categories ? [...picked.categories] : null);
                        setSchedulePresetName(picked.categories ? picked.name : null);
                        setScheduleChangeOpen(false);
                      }}
                      className="ml-5 w-[calc(100%-1.25rem)] border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
                    >
                      {scheduleCategories !== null && schedulePresetName === null && (
                        <option value="__custom__">Custom (current selection)</option>
                      )}
                      {schedulePickOptions.map((o) => (
                        <option key={o.name} value={o.name}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  )}

                  <label className="flex items-center gap-2 text-body text-charcoal">
                    <input
                      type="checkbox"
                      checked={includeSow}
                      onChange={(e) => setIncludeSow(e.target.checked)}
                      className="h-3.5 w-3.5"
                    />
                    <span>
                      Scope of Works
                      {sowAvailability.hasIssuedSow ? (
                        ` (${sowAvailability.latestLabel})`
                      ) : (
                        <span className="text-charcoal/40"> — none issued yet</span>
                      )}
                    </span>
                  </label>
                </div>
              </>
            )}

            {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

            <button
              type="submit"
              disabled={saving || loading}
              className="w-full bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {saving ? "Booking…" : "Book visit"}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
