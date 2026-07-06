"use client";

import { useState } from "react";

/**
 * Milestone-complete diary prompt — Board cockpit round (7 July 2026)
 * chat-agreed improvement: "milestone cards ... completion prompts
 * diary." Shown when a milestone-kind card is moved into a Done-like
 * column (see lib/board-cockpit.ts's shouldPromptMilestoneDiary() for
 * the exact trigger, called from ProjectBoard.tsx's updateTaskField()).
 * A simple "create a draft?" confirm — declining is a no-op (the
 * milestone still completes; this is a nudge, not a gate), accepting
 * POSTs a bare portal_updates draft via the same route the Diary
 * panel's phone-first composer already uses (POST /api/projects/[id]/
 * client-updates/posts), pre-filled with the milestone's own title so
 * staff aren't starting from a blank textarea.
 */
export function MilestoneDiaryPrompt({
  projectId,
  milestoneTitle,
  onDismiss,
  onCreated,
}: {
  projectId: string;
  milestoneTitle: string;
  onDismiss: () => void;
  onCreated: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: milestoneTitle, body_richtext: notes.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not create the diary draft.");
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the diary draft.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={onDismiss}>
      <div
        className="w-full max-w-sm space-y-3 border border-[#dcd6cc] bg-cream p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="label-caps !text-sand">Milestone complete</p>
        <p className="text-body text-nearblack">
          &quot;{milestoneTitle}&quot; is done. Start a client diary entry about it?
        </p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Rough notes (optional) — Aria can polish this into a client-facing entry from the Diary panel."
          rows={3}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
        {error && <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={create}
            disabled={saving}
            className="flex-1 bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
          >
            {saving ? "Creating…" : "Start diary draft"}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal hover:border-nearblack"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
