"use client";

import { useEffect, useState } from "react";
import type { ContactPickerOption } from "@/types/board-cockpit";
import { ContactPicker } from "@/components/shared/ContactPicker";

interface PhaseOption {
  id: string;
  name: string;
  kind: "phase" | "umbrella";
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
 */
export function BookVisitPanel({
  projectId,
  onBook,
  onClose,
}: {
  projectId: string;
  onBook: (input: { phase_id: string; contact_id?: string | null; start_date: string; end_date: string }) => Promise<string | null>;
  onClose: () => void;
}) {
  const [phases, setPhases] = useState<PhaseOption[]>([]);
  const [contacts, setContacts] = useState<ContactPickerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [phaseId, setPhaseId] = useState("");
  const [contactId, setContactId] = useState<string | null>(null);
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-blocking trade-insurance warning — same check every other
  // booking path in the app surfaces. The visit is already booked by
  // the time this renders, so it doesn't block anything; it just keeps
  // the panel open (instead of auto-closing) so the warning is seen.
  const [insuranceWarning, setInsuranceWarning] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch(`/api/projects/${projectId}/phases`).then((r) => (r.ok ? r.json() : { phases: [] })),
      fetch(`/api/contacts`).then((r) => (r.ok ? r.json() : { contacts: [] })),
    ])
      .then(([phasesBody, contactsBody]) => {
        if (cancelled) return;
        const nonUmbrella = (phasesBody.phases ?? []).filter((p: PhaseOption) => p.kind !== "umbrella");
        setPhases(nonUmbrella);
        setContacts(contactsBody.contacts ?? []);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [projectId]);

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
    try {
      const warning = await onBook({ phase_id: phaseId, contact_id: contactId, start_date: startDate, end_date: endDate });
      if (warning) {
        setInsuranceWarning(warning);
      } else {
        onClose();
      }
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

        {insuranceWarning ? (
          // Already booked by this point (onBook succeeded) — the
          // warning is informational, not a reason to keep the form
          // editable/re-submittable. Same non-blocking spirit as
          // AddVisitForm/VisitBottomSheet's own insurance warnings.
          <>
            <p className="border border-sand bg-cream px-2 py-1.5 text-caption text-charcoal">
              Visit booked. {insuranceWarning}
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
                      onChange={(e) => setStartDate(e.target.value)}
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
