"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { ProjectCloseoutReadiness } from "@/types/project-closeout";

type CockpitProps = {
  readiness: ProjectCloseoutReadiness | null;
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
};

export function ProjectCloseoutCockpit({
  readiness,
  loading,
  expanded,
  onToggle,
}: CockpitProps) {
  const attentionCount = readiness?.attention_area_count ?? 0;

  return (
    <div className="mt-4 border border-[#dcd6cc] bg-cream">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-sand/5"
      >
        <span>
          <span className="label-caps block">Closeout readiness</span>
          <span className="mt-1 block text-caption text-charcoal/60">
            {loading && !readiness
              ? "Checking Work, FF&E, Finance and Client…"
              : readiness?.ready
                ? "All five areas are clear."
                : `${attentionCount} of 5 areas need attention before finalising.`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-3">
          {readiness && (
            <span
              className={clsx(
                "border px-2 py-1 text-[7px] font-semibold uppercase tracking-[0.14em]",
                readiness.ready
                  ? "border-[#4c6b4f]/40 bg-[#4c6b4f]/5 text-[#304b33]"
                  : "border-amber-700/35 bg-amber-50 text-amber-800"
              )}
            >
              {readiness.ready ? "Ready" : `${attentionCount} to review`}
            </span>
          )}
          <span aria-hidden className="text-caption text-charcoal/60">
            {expanded ? "Hide" : "Review"}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="border-t border-[#dcd6cc] p-4">
          {loading && !readiness ? (
            <div className="h-24 animate-pulse bg-offwhite" aria-label="Loading closeout readiness" />
          ) : readiness ? (
            <>
              <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
                {readiness.areas.map((area) => (
                  <article
                    key={area.key}
                    className={clsx(
                      "flex min-h-44 flex-col border p-3",
                      area.state === "clear"
                        ? "border-[#4c6b4f]/25 bg-[#4c6b4f]/[0.03]"
                        : "border-amber-700/25 bg-amber-50/50"
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-subhead text-nearblack">{area.label}</h3>
                      <span
                        className={clsx(
                          "shrink-0 text-[8px] font-semibold uppercase tracking-[0.12em]",
                          area.state === "clear" ? "text-[#4c6b4f]" : "text-amber-800"
                        )}
                      >
                        {area.state === "clear" ? "Clear" : "Review"}
                      </span>
                    </div>
                    <p className="mt-3 text-body text-charcoal">{area.summary}</p>
                    <p className="mt-1 text-caption leading-relaxed text-charcoal/55">{area.detail}</p>
                    <a
                      href={area.href}
                      className="mt-auto pt-4 text-caption font-semibold text-nearblack underline decoration-charcoal/25 underline-offset-4 hover:decoration-nearblack"
                    >
                      {area.action}
                    </a>
                  </article>
                ))}
              </div>
              <p className="mt-3 text-caption text-charcoal/50">
                This is a live summary of the existing records. Fix each item in its source area; nothing is copied into a separate checklist.
              </p>
            </>
          ) : (
            <p role="alert" className="text-caption text-red-700">
              Closeout readiness could not be loaded. Refresh before finalising.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

type FinaliseDialogProps = {
  readiness: ProjectCloseoutReadiness;
  saving: boolean;
  onClose: () => void;
  onConfirm: (acknowledged: boolean) => void;
};

export function ProjectFinaliseDialog({
  readiness,
  saving,
  onClose,
  onConfirm,
}: FinaliseDialogProps) {
  const [acknowledged, setAcknowledged] = useState(readiness.ready);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape" && !saving) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, saving]);

  const canConfirm = readiness.ready || acknowledged;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-nearblack/40 p-4"
      onClick={() => {
        if (!saving) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="finalise-job-title"
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-lg border border-[#dcd6cc] bg-cream p-6 shadow-xl"
      >
        <p className="label-caps">Job closeout</p>
        <h2 id="finalise-job-title" className="mt-2 text-xl font-medium text-nearblack">
          {readiness.ready
            ? "Finalise this job?"
            : `Finalise with ${readiness.attention_area_count} areas still needing attention?`}
        </h2>
        <p className="mt-3 text-body leading-relaxed text-charcoal/70">
          Finalising makes the curated handover pack available to the client. It does not archive the job or write off, pay or close any outstanding invoices.
        </p>

        {!readiness.ready && (
          <>
            <ul className="mt-4 space-y-2 border border-amber-700/25 bg-amber-50/60 p-3">
              {readiness.areas
                .filter((area) => area.state === "attention")
                .map((area) => (
                  <li key={area.key} className="text-caption text-charcoal/70">
                    <span className="font-semibold text-nearblack">{area.label}:</span> {area.summary}
                  </li>
                ))}
            </ul>
            <label className="mt-4 flex items-start gap-2 text-body text-charcoal/75">
              <input
                type="checkbox"
                checked={acknowledged}
                disabled={saving}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-0.5 h-4 w-4"
              />
              I have reviewed these live records and intend to finalise with them outstanding.
            </label>
          </>
        )}

        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="border border-charcoal/25 px-4 py-2 text-subhead text-charcoal hover:border-nearblack disabled:opacity-50"
          >
            Keep in Handover
          </button>
          <button
            type="button"
            disabled={saving || !canConfirm}
            onClick={() => onConfirm(acknowledged)}
            className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? "Finalising…" : "Finalise job"}
          </button>
        </div>
      </div>
    </div>
  );
}
