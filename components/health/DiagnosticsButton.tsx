"use client";

import { useState } from "react";
import type { HealthDiagnostic } from "@/types/health-push";

/**
 * Health + web push round (r26), BUILD-SPEC.md item 4's "'Run
 * diagnostics & repair' button." POSTs to /api/health/diagnostics
 * (admin-gated server-side — this button only renders on the
 * admin-only Health page to begin with, see app/(dashboard)/health/
 * page.tsx). Credits ruling: this is the ONLY button in this round
 * that queues any kind of repair work, and it queues the mini's own
 * dumb repair script, never a Claude Code session — see
 * docs/MINI-HEALTH-HANDOFF.md.
 */
export function DiagnosticsButton({ latestDiagnostic }: { latestDiagnostic: HealthDiagnostic | null }) {
  const [pending, setPending] = useState(false);
  const [justRequested, setJustRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function runDiagnostics() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/health/diagnostics", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${res.status})`);
      }
      setJustRequested(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not request diagnostics.");
    } finally {
      setPending(false);
    }
  }

  const inFlight = latestDiagnostic && (latestDiagnostic.status === "pending" || latestDiagnostic.status === "running");

  return (
    <div>
      <button
        type="button"
        onClick={runDiagnostics}
        disabled={pending || !!inFlight}
        className="border border-nearblack bg-nearblack px-4 py-2 text-subhead text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {inFlight ? "Diagnostics in progress…" : pending ? "Requesting…" : "Run diagnostics & repair"}
      </button>
      {justRequested && !inFlight && (
        <p className="mt-2 text-caption text-charcoal/60">Requested — the mini will pick this up shortly.</p>
      )}
      {error && <p className="mt-2 text-caption text-red-700">{error}</p>}

      {latestDiagnostic && (
        <div className="mt-4 border-t border-[#dcd6cc] pt-3 text-caption text-charcoal/70">
          <p className="label-caps text-charcoal/50">Last run — {latestDiagnostic.status}</p>
          <p className="mt-1">
            Requested {new Date(latestDiagnostic.requested_at).toLocaleString("en-AU")}
            {latestDiagnostic.completed_at && ` · completed ${new Date(latestDiagnostic.completed_at).toLocaleString("en-AU")}`}
          </p>
          {latestDiagnostic.report && <p className="mt-2 whitespace-pre-wrap text-charcoal">{latestDiagnostic.report}</p>}
        </div>
      )}
    </div>
  );
}
