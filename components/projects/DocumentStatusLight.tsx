"use client";

import { useState } from "react";
import { DOCUMENT_STATUS_COLOUR, DOCUMENT_STATUS_LABEL, nextDocumentStatus } from "@/lib/sow";
import type { DocumentStatus, ProjectFileKind } from "@/types";

interface Props {
  projectId: string;
  kind: ProjectFileKind;
  status: DocumentStatus;
  /** Called with the new status immediately (optimistic) — caller owns the source of truth. */
  onChanged: (next: DocumentStatus) => void;
  /** Compact = dot + label only (Overview card); full also underlines on hover (Documents tab header). */
  size?: "compact" | "default";
}

/**
 * Traffic-light dot + text label (BUILD-SPEC.md "Project overview
 * hub": "Dots use accessible colours + label text beside them (not
 * colour alone)"). Clicking cycles na -> not_started -> draft -> done
 * -> na. Used on both the Documents overview card and the Documents
 * tab's per-section headers, so the same click-to-cycle affordance and
 * colours appear in both places (BUILD-SPEC.md: "traffic light
 * reflects SOW status automatically" refers to scope_of_works
 * specifically — every kind here is still directly editable by
 * clicking, including scope_of_works, which the SOW issue action ALSO
 * writes to automatically; a manual click still works as an override).
 */
export function DocumentStatusLight({ projectId, kind, status, onChanged, size = "default" }: Props) {
  const [saving, setSaving] = useState(false);

  async function cycle() {
    if (saving) return;
    const next = nextDocumentStatus(status);
    setSaving(true);
    onChanged(next); // optimistic
    try {
      const res = await fetch(`/api/projects/${projectId}/document-status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, status: next }),
      });
      if (!res.ok) {
        onChanged(status); // rollback
      }
    } catch {
      onChanged(status); // rollback
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      type="button"
      onClick={cycle}
      disabled={saving}
      title="Click to update status"
      className="inline-flex items-center gap-1.5 disabled:opacity-60"
    >
      <span
        aria-hidden
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ backgroundColor: DOCUMENT_STATUS_COLOUR[status] }}
      />
      <span
        className={size === "compact" ? "text-caption text-charcoal/70" : "label-caps !text-charcoal/70"}
      >
        {DOCUMENT_STATUS_LABEL[status]}
      </span>
    </button>
  );
}
