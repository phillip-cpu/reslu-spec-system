"use client";

import { useEffect, useState } from "react";
import type { TradeBookingRequestDetail, TradeBookingRequestLine } from "@/types/round-grouped-trade-booking";

/**
 * Grouped trade booking round (r20) — admin detail view for one
 * trade_booking_requests row. Fetches GET /api/trade-requests/[id] on
 * mount, renders every line with its state, and surfaces the two
 * admin actions BUILD-SPEC.md item 5 describes for a 'date_suggested'
 * line: "Accept new date + shift timeline" and "Keep original +
 * reply" — both POST /api/trade-requests/[id]/lines/[visitId]/resolve.
 * A resend button (item 6) is shown whenever the request is still
 * `status = 'sent'` (nothing left to resend once every line has been
 * responded to).
 *
 * The "shift timeline" half of accept_shift is a SEPARATE, explicit
 * follow-up click — this component never auto-calls shift-items. When
 * the resolve response carries a `shift_offer`, a small inline banner
 * appears offering to also shift the rest of that phase's tasks by the
 * same delta, via a plain POST to the EXISTING, unmodified
 * /api/phases/[id]/shift-items route (BUILD-SPEC.md: "do NOT
 * reimplement ripple math") — dismissible without shifting anything.
 */
export function TradeRequestDetail({ requestId }: { requestId: string }) {
  const [detail, setDetail] = useState<TradeBookingRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shiftOffer, setShiftOffer] = useState<{ phase_id: string; delta_days: number } | null>(null);
  const [resending, setResending] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/trade-requests/${requestId}`);
      if (!res.ok) throw new Error("Could not load this request.");
      setDetail(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this request.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  async function resolveLine(visitId: string, body: Record<string, unknown>) {
    setError(null);
    try {
      const res = await fetch(`/api/trade-requests/${requestId}/lines/${visitId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not update this line.");
      if (json.shift_offer) setShiftOffer(json.shift_offer);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this line.");
    }
  }

  async function applyShift() {
    if (!shiftOffer) return;
    try {
      const res = await fetch(`/api/phases/${shiftOffer.phase_id}/shift-items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ delta_days: shiftOffer.delta_days }),
      });
      if (!res.ok) throw new Error("Could not shift the rest of this phase.");
      setNotice("Timeline shifted for the rest of this phase.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not shift the timeline.");
    } finally {
      setShiftOffer(null);
    }
  }

  async function resend() {
    setResending(true);
    setError(null);
    try {
      const res = await fetch(`/api/trade-requests/${requestId}/resend`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not resend.");
      setNotice(json.email_sent ? "Follow-up email sent." : `Not sent: ${json.email_skip_reason ?? "unknown reason"}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend.");
    } finally {
      setResending(false);
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading…</p>;
  if (error && !detail) return <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>;
  if (!detail) return null;

  return (
    <div className="max-w-2xl space-y-4">
      <div className="border border-[#dcd6cc] bg-offwhite px-4 py-3">
        <p className="label-caps">{detail.project?.name ?? "Project"}</p>
        <p className="mt-1 text-subhead text-nearblack">{detail.contact?.company ?? "Trade"}</p>
        <p className="mt-1 text-caption text-charcoal/60">
          Status: {detail.request.status}
          {detail.request.sent_at ? ` · sent ${detail.request.sent_at.slice(0, 10)}` : ""}
        </p>
      </div>

      {notice && <p className="border border-sand bg-cream px-3 py-2 text-body text-charcoal">{notice}</p>}
      {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

      {shiftOffer && (
        <div className="flex items-center justify-between gap-3 border border-sand bg-cream px-3 py-2 text-body text-charcoal">
          <span>
            Shift the rest of this phase&apos;s tasks by {shiftOffer.delta_days > 0 ? "+" : ""}
            {shiftOffer.delta_days} day{Math.abs(shiftOffer.delta_days) === 1 ? "" : "s"}?
          </span>
          <div className="flex shrink-0 gap-2">
            <button type="button" onClick={applyShift} className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal">
              Shift timeline
            </button>
            <button type="button" onClick={() => setShiftOffer(null)} className="text-caption text-charcoal/50 underline hover:text-nearblack">
              Not now
            </button>
          </div>
        </div>
      )}

      {detail.request.status === "sent" && (
        <button
          type="button"
          onClick={resend}
          disabled={resending}
          className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-60"
        >
          {resending ? "Resending…" : "Resend request"}
        </button>
      )}

      <div className="space-y-2">
        {detail.lines.map((line) => (
          <LineCard key={line.id} line={line} onResolve={(body) => resolveLine(line.id, body)} />
        ))}
      </div>
    </div>
  );
}

function LineCard({
  line,
  onResolve,
}: {
  line: TradeBookingRequestLine;
  onResolve: (body: Record<string, unknown>) => void;
}) {
  const dateLabel = line.start_date === line.end_date ? line.start_date : `${line.start_date} → ${line.end_date}`;

  return (
    <div className="border border-[#dcd6cc] px-4 py-3">
      <div className="flex items-center justify-between">
        <p className="text-body text-nearblack">{line.task_title}</p>
        <span className="label-caps text-charcoal/50">{line.line_status.replace("_", " ")}</span>
      </div>
      <p className="mt-1 text-caption text-charcoal/60">{dateLabel}</p>

      {line.line_status === "date_suggested" && (
        <div className="mt-2 border border-[#c9c2b4] bg-nearwhite px-3 py-2">
          <p className="text-caption text-charcoal/60">
            Suggested: {line.suggested_start}
            {line.suggested_end !== line.suggested_start ? ` → ${line.suggested_end}` : ""}
          </p>
          {line.response_note && <p className="mt-1 text-caption text-charcoal/50">&quot;{line.response_note}&quot;</p>}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => onResolve({ action: "accept_shift" })}
              className="bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal"
            >
              Accept new date
            </button>
            <button
              type="button"
              onClick={() => onResolve({ action: "keep_reply" })}
              className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
            >
              Keep original + reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
