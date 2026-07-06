"use client";

import { useState } from "react";

/**
 * "Dates changed — re-send confirmation?" — BUILD-SPEC.md "Internal
 * timeline — trade visit sub-bars": non-blocking affordance shown on a
 * visit sub-bar right after a successful drag/resize PATCH, ONLY when
 * that visit's status was 'confirmed' at the moment the drag started
 * (GanttChart.tsx's commitVisitDrag decides when to mount this — see
 * that function's doc comment for the full "why" and the state-machine
 * finding written up in app/api/visits/[id]/resend-confirmation/route.ts).
 *
 * Deliberately its own small floating strip rather than baked into
 * VisitSubBar itself — it needs to survive being dismissed
 * independently of the bar re-rendering (a new drag on the SAME visit
 * before this is dismissed simply replaces it, handled by the parent
 * keying this by visit id).
 */
export function ReconfirmAffordance({
  onResend,
  onDismiss,
}: {
  onResend: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function handleResend() {
    setSending(true);
    setError(null);
    try {
      await onResend();
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not re-send confirmation.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-2 border border-sand bg-cream px-2 py-1 text-caption text-charcoal">
      {sent ? (
        <span>Confirmation re-sent · status reset to unconfirmed.</span>
      ) : (
        <>
          <span>Dates changed — re-send confirmation?</span>
          <button
            type="button"
            onClick={handleResend}
            disabled={sending}
            className="border border-nearblack bg-nearblack px-2 py-0.5 text-white transition-colors hover:bg-charcoal disabled:opacity-60"
          >
            {sending ? "Sending…" : "Re-send"}
          </button>
          <button type="button" onClick={onDismiss} className="text-charcoal/50 underline hover:text-nearblack">
            Dismiss
          </button>
        </>
      )}
      {error && <span className="text-red-700">{error}</span>}
      {sent && (
        <button type="button" onClick={onDismiss} className="text-charcoal/50 underline hover:text-nearblack">
          Close
        </button>
      )}
    </div>
  );
}
