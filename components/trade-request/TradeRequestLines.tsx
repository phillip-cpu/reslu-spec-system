"use client";

import { useState } from "react";

export interface TradeRequestLineView {
  id: string;
  task_title: string;
  start_date: string;
  end_date: string;
  line_status: "proposed" | "accepted" | "date_suggested";
  suggested_start: string | null;
  suggested_end: string | null;
  response_note: string | null;
}

type RowMode = "idle" | "suggest";

/**
 * Grouped trade booking round (r20) — the per-line Accept / Suggest
 * date controls on /trade-request/[token] (BUILD-SPEC.md item 3:
 * "Per line: Accept, or Suggest date (date range picker + optional
 * note)"). Mobile-first, mirrors components/trade/TradeRespondForm.tsx's
 * own tap-target sizing/brand conventions exactly, adapted to a LIST of
 * lines instead of one single-visit form.
 *
 * Each line manages its own local `mode`/error/submitting state
 * independently — one line's in-flight submit never disables another
 * line's controls (partial responses are explicitly allowed per BUILD-
 * SPEC.md item 3). Accepted lines render LOCKED (no buttons at all,
 * matching "accepted lines lock immediately... page re-renders current
 * state on reload"); a 'date_suggested' line still shows its own
 * suggestion read-only plus the option to change it again (suggesting
 * again before staff has acted simply overwrites the prior suggestion
 * — no separate "cancel" affordance needed for that case).
 */
export function TradeRequestLines({ token, lines }: { token: string; lines: TradeRequestLineView[] }) {
  return (
    <div className="space-y-3">
      {lines.map((line) => (
        <LineRow key={line.id} token={token} line={line} />
      ))}
    </div>
  );
}

function LineRow({ token, line: initialLine }: { token: string; line: TradeRequestLineView }) {
  const [line, setLine] = useState(initialLine);
  const [mode, setMode] = useState<RowMode>("idle");
  const [suggestedStart, setSuggestedStart] = useState(initialLine.suggested_start ?? "");
  const [suggestedEnd, setSuggestedEnd] = useState(initialLine.suggested_end ?? "");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(body: Record<string, unknown>) {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/trade-request/${token}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ line_id: line.id, ...body }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(json.error ?? "Something went wrong. Please try again.");
      }
      setLine(json.line);
      setMode("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setSubmitting(false);
    }
  }

  const dateLabel = line.start_date === line.end_date ? line.start_date : `${line.start_date} → ${line.end_date}`;

  return (
    <div className="border border-[#dcd6cc] bg-offwhite px-4 py-4">
      <p className="text-subhead text-nearblack">{line.task_title}</p>
      <p className="mt-1 text-body text-charcoal/70">{dateLabel}</p>

      {line.line_status === "accepted" && (
        <p className="mt-3 border border-sand bg-cream px-3 py-2 text-caption text-charcoal">Accepted — locked in.</p>
      )}

      {line.line_status === "date_suggested" && mode === "idle" && (
        <div className="mt-3 border border-[#c9c2b4] bg-nearwhite px-3 py-2">
          <p className="label-caps">You suggested</p>
          <p className="mt-1 text-body text-nearblack">
            {line.suggested_start}
            {line.suggested_end !== line.suggested_start ? ` → ${line.suggested_end}` : ""}
          </p>
          {line.response_note && <p className="mt-1 text-caption text-charcoal/60">{line.response_note}</p>}
          <p className="mt-1 text-caption text-charcoal/50">Waiting on RESLU to respond.</p>
        </div>
      )}

      {error && <p className="mt-2 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

      {line.line_status !== "accepted" && mode === "idle" && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => submit({ action: "accept" })}
            disabled={submitting}
            className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
          >
            Accept
          </button>
          <button
            type="button"
            onClick={() => setMode("suggest")}
            className="flex-1 border border-nearblack px-4 py-3 text-subhead text-nearblack hover:bg-nearblack hover:text-white"
          >
            {line.line_status === "date_suggested" ? "Change suggestion" : "Suggest date"}
          </button>
        </div>
      )}

      {line.line_status !== "accepted" && mode === "suggest" && (
        <div className="mt-3 border border-[#dcd6cc] bg-nearwhite px-3 py-3">
          <p className="label-caps mb-2">Suggest a different date</p>
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-caption text-charcoal/60">From</span>
              <input
                type="date"
                value={suggestedStart}
                onChange={(e) => setSuggestedStart(e.target.value)}
                className="border border-[#c9c2b4] bg-white px-2 py-2 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-caption text-charcoal/60">To</span>
              <input
                type="date"
                value={suggestedEnd}
                onChange={(e) => setSuggestedEnd(e.target.value)}
                className="border border-[#c9c2b4] bg-white px-2 py-2 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
          </div>
          <label className="mt-3 flex flex-col gap-1">
            <span className="text-caption text-charcoal/60">Note (optional)</span>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="border border-[#c9c2b4] bg-white px-2 py-2 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (!suggestedStart || !suggestedEnd) {
                  setError("Please choose a date.");
                  return;
                }
                submit({ action: "suggest", suggested_start: suggestedStart, suggested_end: suggestedEnd, response_note: note.trim() || undefined });
              }}
              disabled={submitting}
              className="flex-1 bg-nearblack px-4 py-3 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              Send suggestion
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
