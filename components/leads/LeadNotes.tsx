"use client";

import { useEffect, useState } from "react";
import type { LeadNote } from "@/types/round-d";

interface Props {
  leadId: string;
  onError: (msg: string | null) => void;
}

/**
 * "{author_name} · 7 Jul, 10:42am" — en-AU date + 12-hour time, per
 * BUILD-SPEC.md's migration 030 round spec for the lead notes feed.
 * `hour12: true` with a lower-cased, space-stripped am/pm suffix (the
 * `Intl` en-AU formatter renders "10:42 am" — the spec's example has no
 * space before am/pm, e.g. "10:42am").
 */
function formatWhen(iso: string): string {
  const d = new Date(iso);
  const datePart = d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  const timePart = d
    .toLocaleTimeString("en-AU", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?([ap])\.?m\.?/i, (_m, ap: string) => `${ap.toLowerCase()}m`);
  return `${datePart}, ${timePart}`;
}

/**
 * Lead notes feed — mirrors components/items/ItemNotes.tsx exactly
 * (same shape: timestamped feed + composer), against
 * GET/POST /api/leads/[id]/notes instead of the item notes route.
 * Migration 030 round: replaces the old free-text `leads.notes`
 * textarea in LeadDetailPanel.tsx as the editable notes surface —
 * newest-first (item notes are oldest-first; this feed is explicitly
 * "newest-first" per this round's own spec, so the composer's own
 * fresh note is immediately visible at the top without scrolling a
 * growing list).
 */
export function LeadNotes({ leadId, onError }: Props) {
  const [notes, setNotes] = useState<LeadNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    function load() {
      fetch(`/api/leads/${leadId}/notes`)
        .then((r) => r.json())
        .then((d) => active && setNotes(d.notes ?? []))
        .catch(() => {})
        .finally(() => active && setLoading(false));
    }
    load();
    const eventName = `lead-notes-updated:${leadId}`;
    window.addEventListener(eventName, load);
    return () => {
      active = false;
      window.removeEventListener(eventName, load);
    };
  }, [leadId]);

  async function add() {
    if (!text.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add note");
      const { note } = await res.json();
      setNotes((cur) => [note, ...cur]);
      setText("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="label-caps mb-2 !text-charcoal/50">Notes</p>
      <div className="mb-3 flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="Add a note…"
          className="flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <button
          type="button"
          disabled={saving || !text.trim()}
          onClick={add}
          className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
        >
          {saving ? "Adding…" : "Add"}
        </button>
      </div>
      {loading ? (
        <p className="text-caption text-charcoal/40">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="text-caption text-charcoal/40">No notes yet.</p>
      ) : (
        <ul className="space-y-2">
          {notes.map((n) => (
            <li key={n.id} className="border-l-2 border-[#dcd6cc] pl-2">
              <p className="text-body text-charcoal">{n.text}</p>
              <p className="text-caption text-charcoal/40">
                {n.author_name} · {formatWhen(n.created_at)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
