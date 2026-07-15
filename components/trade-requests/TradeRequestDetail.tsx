"use client";

import { useEffect, useState } from "react";
import type { TradeBookingRequestDetail, TradeBookingRequestLine } from "@/types/round-grouped-trade-booking";
import { formatShortDateAU, formatDateRangeAU } from "@/lib/gantt-window";
import { BookingDeliveryTimeline, BookingProgressPill } from "./BookingProgress";

export function TradeRequestDetail({ requestId }: { requestId: string }) {
  const [detail, setDetail] = useState<TradeBookingRequestDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shiftOffer, setShiftOffer] = useState<{ phase_id: string; delta_days: number } | null>(null);
  const [resending, setResending] = useState(false);
  const [confirmingVisitId, setConfirmingVisitId] = useState<string | null>(null);

  async function load(showSpinner = true) {
    if (showSpinner) setLoading(true);
    try {
      const res = await fetch(`/api/trade-requests/${requestId}`, { cache: "no-store" });
      if (!res.ok) throw new Error("Could not load this booking request.");
      setDetail(await res.json());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load this booking request.");
    } finally {
      if (showSpinner) setLoading(false);
    }
  }

  useEffect(() => {
    const initial = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => load(false), 60_000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
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
      if (!res.ok) throw new Error(json.error ?? "Could not update this booking line.");
      if (json.shift_offer) setShiftOffer(json.shift_offer);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update this booking line.");
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
      if (!res.ok) throw new Error(json.error ?? "Could not resend the email.");
      setNotice(
        json.email_action === "sent"
          ? "Follow-up email sent. Delivery tracking has restarted for this send."
          : json.email_action === "queued"
            ? "Follow-up email queued for the next permitted sending window."
            : `Email not sent: ${json.email_skip_reason ?? "unknown reason"}.`
      );
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not resend the email.");
    } finally {
      setResending(false);
    }
  }

  async function copyBookingLink() {
    if (!detail) return;
    const url = `${window.location.origin}/trade-request/${detail.request.token}`;
    try {
      await navigator.clipboard.writeText(url);
      setNotice("Booking link copied.");
    } catch {
      setError("Could not copy the booking link automatically.");
    }
  }

  async function markConfirmed(visitId: string) {
    setConfirmingVisitId(visitId);
    setError(null);
    try {
      const res = await fetch(`/api/visits/${visitId}/confirm`, { method: "POST" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not confirm this visit.");
      setNotice(
        json.calendar_warning
          ? `Visit marked confirmed. Calendar warning: ${json.calendar_warning}`
          : "Visit marked confirmed."
      );
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not confirm this visit.");
    } finally {
      setConfirmingVisitId(null);
    }
  }

  if (loading) return <p className="text-body text-charcoal/50">Loading booking status…</p>;
  if (error && !detail) return <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>;
  if (!detail) return null;

  const canResend =
    detail.counts.outstanding > 0 &&
    detail.request.status === "sent" &&
    detail.email?.status !== "pending";

  return (
    <div className="max-w-5xl space-y-5">
      <section className="border border-[#dcd6cc] bg-offwhite px-5 py-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-caps">{detail.project?.name ?? "Project"}</p>
            <h2 className="mt-1 font-display text-section text-nearblack">
              {detail.contact?.company ?? "Trade booking"}
            </h2>
            <p className="mt-1 text-body text-charcoal/60">
              {detail.contact?.email ?? "No trade email address on file"} · {detail.counts.total} booking line{detail.counts.total === 1 ? "" : "s"}
            </p>
          </div>
          <BookingProgressPill progress={detail.progress} />
        </div>
        <p className="mt-4 max-w-2xl text-body text-charcoal/70">{detail.progress.explanation}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {canResend && (
            <button
              type="button"
              onClick={resend}
              disabled={resending}
              className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {resending ? "Resending…" : "Resend to trade"}
            </button>
          )}
          <button
            type="button"
            onClick={copyBookingLink}
            className="border border-nearblack px-4 py-2 text-subhead text-nearblack hover:bg-nearblack hover:text-white"
          >
            Copy booking link
          </button>
          <a
            href={`/trade-request/${detail.request.token}?preview=1`}
            target="_blank"
            rel="noreferrer"
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack hover:text-nearblack"
          >
            Preview trade view
          </a>
        </div>
      </section>

      {notice && <p className="border border-sand bg-cream px-3 py-2 text-body text-charcoal">{notice}</p>}
      {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}

      {detail.email?.status === "sent" && !detail.email.provider_message_id && (
        <p className="border border-[#dcd6cc] bg-nearwhite px-3 py-2 text-caption text-charcoal/60">
          This email was sent before provider delivery tracking was enabled. Its booking-page open and trade response are still tracked.
        </p>
      )}

      <section>
        <div className="mb-2 flex items-end justify-between gap-3">
          <div>
            <p className="label-caps">Delivery & response</p>
            <p className="mt-1 text-caption text-charcoal/50">Delivery means the recipient&apos;s mail server accepted the email; it is not proof of a human read.</p>
          </div>
        </div>
        <BookingDeliveryTimeline detail={detail} />
      </section>

      {shiftOffer && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-sand bg-cream px-4 py-3 text-body text-charcoal">
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

      <section>
        <div className="mb-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="label-caps">Booking lines</p>
            <p className="mt-1 text-caption text-charcoal/50">
              {detail.counts.accepted} confirmed · {detail.counts.date_suggested} date suggested · {detail.counts.outstanding} awaiting response
            </p>
          </div>
        </div>
        <div className="space-y-2">
          {detail.lines.map((line) => (
            <LineCard
              key={line.id}
              line={line}
              onResolve={(body) => resolveLine(line.id, body)}
              onConfirm={() => markConfirmed(line.id)}
              confirming={confirmingVisitId === line.id}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

const lineStatusLabels: Record<TradeBookingRequestLine["line_status"], string> = {
  proposed: "Awaiting trade",
  accepted: "Confirmed",
  date_suggested: "New date suggested",
};

function LineCard({
  line,
  onResolve,
  onConfirm,
  confirming,
}: {
  line: TradeBookingRequestLine;
  onResolve: (body: Record<string, unknown>) => void;
  onConfirm: () => void;
  confirming: boolean;
}) {
  const dateLabel =
    line.start_date === line.end_date
      ? formatShortDateAU(line.start_date)
      : formatDateRangeAU(line.start_date, line.end_date);

  return (
    <div id={`line-${line.id}`} className="border border-[#dcd6cc] bg-offwhite px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-body text-nearblack">{line.task_title}</p>
          <p className="mt-1 text-caption text-charcoal/60">{dateLabel} · {line.phase_name}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="label-caps text-charcoal/60">{lineStatusLabels[line.line_status]}</span>
          {line.line_status === "proposed" && (
            <button
              type="button"
              onClick={onConfirm}
              disabled={confirming}
              className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-50"
            >
              {confirming ? "Confirming…" : "Mark confirmed"}
            </button>
          )}
        </div>
      </div>

      {line.line_status === "date_suggested" && (
        <div className="mt-3 border border-[#c9c2b4] bg-nearwhite px-3 py-3">
          <p className="text-body text-nearblack">
            Trade suggested{" "}
            {line.suggested_start &&
              (line.suggested_end && line.suggested_end !== line.suggested_start
                ? formatDateRangeAU(line.suggested_start, line.suggested_end)
                : formatShortDateAU(line.suggested_start))}
          </p>
          {line.response_note && <p className="mt-1 text-caption text-charcoal/60">&quot;{line.response_note}&quot;</p>}
          <div className="mt-3 flex flex-wrap gap-2">
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
