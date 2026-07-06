"use client";

import { useState } from "react";

interface Props {
  projectId: string;
  onDismiss: () => void;
}

/**
 * The WD-Package hinge — BUILD-SPEC.md §"12b Design Framework": "Flow
 * linkage: completing WD Package prompts SOW + estimate version
 * creation ('design package -> quoting')." This task's brief: "when WD
 * Package phase status -> complete, show a one-time prompt panel
 * (non-blocking, dismissible): 'Design package complete — start
 * quoting?' with two actions: 'Create SOW from template' ... and 'Save
 * estimate version' ... Record dismissal ... so it doesn't nag."
 *
 * Rendered by DesignTab only when
 * lib/design-framework.ts's shouldShowWdPackageHinge() is true (WD
 * Package phase status = 'complete' AND hinge_dismissed_at is still
 * null) — see that function's doc comment. Non-blocking: this panel
 * never prevents any other Design tab interaction, it's just an extra
 * banner at the top of the tab.
 *
 * Both actions are genuinely OPTIONAL and dismissible independently of
 * each other — clicking either one does NOT auto-dismiss the panel
 * (a team member might want to do both, one after the other, before
 * dismissing) — only the explicit "Dismiss" button (or the ✕) records
 * hinge_dismissed_at via the parent's onDismiss callback.
 */
export function WdPackageHingePanel({ projectId, onDismiss }: Props) {
  const [creatingSow, setCreatingSow] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [sowError, setSowError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [versionSaved, setVersionSaved] = useState(false);

  /**
   * "Create SOW from template" — creates a brand-new draft SOW revision
   * (POST /api/projects/[id]/sow, the existing "first revision" route —
   * unchanged, protected file boundary respected) then immediately
   * applies the standard clause library to it
   * (POST /api/projects/[id]/sow/[sowId]/from-template, also existing/
   * unchanged) before handing off to the SOW builder page — the exact
   * same two-step flow a team member would do manually from the
   * Documents tab, just chained for convenience from this prompt.
   */
  async function createSowFromTemplate() {
    setSowError(null);
    setCreatingSow(true);
    try {
      const createRes = await fetch(`/api/projects/${projectId}/sow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const createBody = await createRes.json().catch(() => ({}));
      if (!createRes.ok) throw new Error(createBody.error ?? "Could not create a new SOW revision.");
      const sowId = createBody.sow?.id;
      if (sowId) {
        const templateRes = await fetch(`/api/projects/${projectId}/sow/${sowId}/from-template`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!templateRes.ok) {
          // The SOW revision itself was created fine — template
          // application failing is a soft error; still route the team
          // to the builder so they can apply it manually or start
          // writing from scratch.
          const templateBody = await templateRes.json().catch(() => ({}));
          setSowError(templateBody.error ?? "SOW created, but the template could not be applied — open the builder to apply it manually.");
        }
      }
      window.location.href = `/projects/${projectId}/sow`;
    } catch (err) {
      setSowError(err instanceof Error ? err.message : "Could not create SOW.");
      setCreatingSow(false);
    }
  }

  /**
   * "Save estimate version" — POST /api/projects/[id]/versions (existing,
   * unchanged route) with the label suggested by BUILD-SPEC.md's own
   * example wording, kind 'issue' (a real quoting milestone snapshot,
   * not a VM cost-reduction revision). Admin-only server-side (every
   * estimate route in this codebase is financial-gated) — a non-admin
   * clicking this sees the route's own 403 message surfaced inline
   * rather than the button being hidden, since the Design tab itself is
   * team-visible (not admin-gated) and this hinge panel is the one
   * place a non-admin might reasonably brush up against an admin-only
   * action.
   */
  async function saveEstimateVersion() {
    setVersionError(null);
    setSavingVersion(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "V1 — Design Package", kind: "issue" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save estimate version.");
      setVersionSaved(true);
    } catch (err) {
      setVersionError(err instanceof Error ? err.message : "Could not save estimate version.");
    } finally {
      setSavingVersion(false);
    }
  }

  return (
    <div className="border border-sand bg-cream px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-sand">Design package complete</p>
          <p className="mt-1 text-body text-nearblack">Start quoting?</p>
        </div>
        <button
          type="button"
          onClick={onDismiss}
          title="Dismiss — won't show again for this project"
          className="text-caption text-charcoal/40 hover:text-nearblack"
        >
          ✕
        </button>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={createSowFromTemplate}
          disabled={creatingSow}
          className="border border-nearblack px-3 py-1.5 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-50"
        >
          {creatingSow ? "Creating…" : "Create SOW from template"}
        </button>
        <button
          type="button"
          onClick={saveEstimateVersion}
          disabled={savingVersion || versionSaved}
          className="border border-nearblack px-3 py-1.5 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-50"
        >
          {versionSaved ? "Version saved ✓" : savingVersion ? "Saving…" : "Save estimate version"}
        </button>
        <button type="button" onClick={onDismiss} className="text-caption text-charcoal/50 hover:text-nearblack">
          Dismiss
        </button>
      </div>

      {sowError && <p className="mt-2 text-caption text-red-700">{sowError}</p>}
      {versionError && <p className="mt-2 text-caption text-red-700">{versionError}</p>}
    </div>
  );
}
