"use client";

import { useEffect, useState } from "react";
import type { ItemNote } from "@/types";

interface Props {
  itemId: string;
  onError: (msg: string | null) => void;
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export function ItemNotes({ itemId, onError }: Props) {
  const [notes, setNotes] = useState<ItemNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    fetch(`/api/items/${itemId}/notes`)
      .then((r) => r.json())
      .then((d) => active && setNotes(d.notes ?? []))
      .catch(() => {})
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [itemId]);

  async function add() {
    if (!text.trim()) return;
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/items/${itemId}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add note");
      const { note } = await res.json();
      setNotes((cur) => [...cur, note]);
      setText("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add note");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <p className="label-caps mb-2">Notes</p>
      {loading ? (
        <p className="text-caption text-charcoal/40">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="mb-2 text-caption text-charcoal/40">No notes yet.</p>
      ) : (
        <ul className="mb-3 space-y-2">
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
      <div className="flex items-end gap-2">
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
    </div>
  );
}
