"use client";

import { useState } from "react";
import clsx from "clsx";
import type { ArrivalSlot } from "@/lib/trade-visits";

const SLOT_OPTIONS: { key: ArrivalSlot; label: string }[] = [
  { key: "first_thing", label: "First thing" },
  { key: "midday", label: "Midday" },
  { key: "afternoon", label: "Afternoon" },
];

type Mode = "idle" | "confirm" | "different_time" | "propose" | "done";

/**
 * The three trade-facing actions on /trade/[token] — Confirm (as-is),
 * Confirm a different time (same day, auto-accepted), Propose another
 * day. Client component (posts to POST /api/trade/[token]/respond);
 * everything else on the page is a plain Server Component.
 *
 * Mobile-first per BUILD-SPEC ("90% phones"): single column, large
 * tap targets (full-width buttons, generous padding), no hover-only
 * affordances, sharp corners, sand used only as a small accent
 * (selected-state border), never a large fill.
 *
 * If `hasArrival` is false (the visit has no arrival_slot/arrival_time
 * nominated at all yet), tapping "Confirm" does NOT immediately submit
 * — it forces the arrival picker open first (mirrored server-side: the
 * respond route 400s a bare confirm with no slot/time in that case
 * too), since BUILD-SPEC requires a first-time arrival nomination
 * before a confirm can complete.
 */
export function TradeRespondForm({
  token,
  hasArrival,
  currentStatus,
}: {
  token: string;
  hasArrival: boolean;
  currentStatus: string;
}) {
  const [mode, setMode] = useState<Mode>("idle");
  const [slot, setSlot] = useState<ArrivalSlot | null>(null);
  const [time, setTime] = useState("");
  const [proposedStart, setProposedStart] = useState("");
  const [proposedEnd, setProposedEnd] = useState("");
  const [proposedNote, setProposedNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);


  async function submit(body: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/trade/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Something went wrong. Please try again.");
      }
      setMode("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  function handleConfirmTap() {
    if (!hasArrival) {
      setMode("confirm"); // force the picker open
      return;
    }
    submit({ action: "confirm" });
  }

  function submitConfirmWithArrival() {
    if (!slot && !time) {
      setError("Please choose an arrival time.");
      return;
    }
    submit({ action: "confirm", arrival_slot: slot, arrival_time: time || undefined });
  }

  function submitDifferentTime() {
    if (!slot && !time) {
      setError("Please choose an arrival time.");
      return;
    }
    submit({ action: "confirm_different_time", arrival_slot: slot, arrival_time: time || undefined });
  }

  function submitPropose() {
    if (!proposedStart || !proposedEnd) {
      setError("Please choose a proposed date.");
      return;
    }
    submit({
      action: "propose",
      proposed_start: proposedStart,
      proposed_end: proposedEnd,
      proposed_slot: slot,
      proposed_time: time || undefined,
      proposed_note: proposedNote.trim() || undefined,
    });
  }

  if (mode === "done") {
    return (
      <div className="border border-[#dcd6cc] bg-offwhite px-5 py-6 text-center">
        <p className="text-body text-nearblack">Thanks — we&apos;ve recorded your response.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

      {mode === "idle" && (
        <>
          {currentStatus === "confirmed" && (
            <p className="border border-[#dcd6cc] bg-offwhite px-4 py-3 text-body text-charcoal/70">
              This visit is already confirmed. You can still change the time or propose another day below.
            </p>
          )}
          {currentStatus !== "confirmed" && (
            <button
              type="button"
              onClick={handleConfirmTap}
              disabled={submitting}
              className="w-full bg-nearblack px-5 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
            >
              Confirm as-is
            </button>
          )}
          <button
            type="button"
            onClick={() => setMode("different_time")}
            className="w-full border border-nearblack px-5 py-4 text-subhead text-nearblack hover:bg-nearblack hover:text-white"
          >
            Confirm a different time
          </button>
          <button
            type="button"
            onClick={() => setMode("propose")}
            className="w-full border border-[#c9c2b4] px-5 py-4 text-subhead text-charcoal hover:border-nearblack"
          >
            Propose another day
          </button>
        </>
      )}

      {mode === "confirm" && (
        <div className="border border-[#dcd6cc] bg-offwhite px-4 py-4">
          <p className="label-caps mb-2">Choose an arrival time to confirm</p>
          <ArrivalPicker slot={slot} time={time} onSlot={setSlot} onTime={setTime} />
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={submitConfirmWithArrival}
              disabled={submitting}
              className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              Confirm
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="border border-[#c9c2b4] px-4 py-3 text-subhead text-charcoal hover:border-nearblack"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {mode === "different_time" && (
        <div className="border border-[#dcd6cc] bg-offwhite px-4 py-4">
          <p className="label-caps mb-2">New arrival time (same day)</p>
          <ArrivalPicker slot={slot} time={time} onSlot={setSlot} onTime={setTime} />
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={submitDifferentTime}
              disabled={submitting}
              className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              Confirm this time
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="border border-[#c9c2b4] px-4 py-3 text-subhead text-charcoal hover:border-nearblack"
            >
              Back
            </button>
          </div>
        </div>
      )}

      {mode === "propose" && (
        <div className="border border-[#dcd6cc] bg-offwhite px-4 py-4">
          <p className="label-caps mb-2">Propose another day</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-caption text-charcoal/60">From</span>
              <input
                type="date"
                value={proposedStart}
                onChange={(e) => setProposedStart(e.target.value)}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption text-charcoal/60">To</span>
              <input
                type="date"
                value={proposedEnd}
                onChange={(e) => setProposedEnd(e.target.value)}
                className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
          </div>
          <div className="mt-3">
            <ArrivalPicker slot={slot} time={time} onSlot={setSlot} onTime={setTime} />
          </div>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-caption text-charcoal/60">Note (optional)</span>
            <input
              value={proposedNote}
              onChange={(e) => setProposedNote(e.target.value)}
              className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={submitPropose}
              disabled={submitting}
              className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              Send proposal
            </button>
            <button
              type="button"
              onClick={() => setMode("idle")}
              className="border border-[#c9c2b4] px-4 py-3 text-subhead text-charcoal hover:border-nearblack"
            >
              Back
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ArrivalPicker({
  slot,
  time,
  onSlot,
  onTime,
}: {
  slot: ArrivalSlot | null;
  time: string;
  onSlot: (s: ArrivalSlot | null) => void;
  onTime: (t: string) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-3 gap-2">
        {SLOT_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            type="button"
            onClick={() => {
              onSlot(opt.key);
              onTime("");
            }}
            className={clsx(
              "border px-2 py-3 text-caption",
              slot === opt.key ? "border-sand bg-sand/10 text-nearblack" : "border-[#c9c2b4] text-charcoal"
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-caption text-charcoal/60">Or a specific time</span>
        <input
          type="time"
          value={time}
          onChange={(e) => {
            onTime(e.target.value);
            if (e.target.value) onSlot(null);
          }}
          className="border border-[#c9c2b4] bg-nearwhite px-2 py-2 text-body focus:border-nearblack focus:outline-none"
        />
      </label>
    </div>
  );
}
