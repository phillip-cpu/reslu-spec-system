"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import type { UserNote } from "@/types/phase-12a-b";

/**
 * Personal notes panel (BUILD-SPEC.md §"Phase 12a — My Work":
 * "Personal notes section (user_notes table: user_id, text, done,
 * created_at)"). CRUD against /api/my-work/notes[/[id]] — always
 * scoped to the signed-in user (no project/team concept here, it's a
 * private scratchpad). Optimistic tick/add, following this codebase's
 * established "update local state immediately, roll back on API
 * failure" pattern (components/board/ProjectBoard.tsx's updateTaskField).
 */
export function NotesPanel() {
  const [notes, setNotes] = useState<UserNote[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    fetch("/api/my-work/notes")
      .then((r) => r.json())
      .then((body) => setNotes(body.notes ?? []))
      .catch(() => setError("Could not load notes."));
  }, []);

  async function addNote(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const res = await fetch("/api/my-work/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add note.");
      const { note } = await res.json();
      setNotes((cur) => [note, ...(cur ?? [])]);
      setDraft("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add note.");
    } finally {
      setAdding(false);
    }
  }

  async function toggleDone(note: UserNote) {
    const prev = notes;
    setNotes((cur) => (cur ?? []).map((n) => (n.id === note.id ? { ...n, done: !n.done } : n)));
    setError(null);
    try {
      const res = await fetch(`/api/my-work/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ done: !note.done }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update note.");
    } catch (err) {
      setNotes(prev);
      setError(err instanceof Error ? err.message : "Could not update note.");
    }
  }

  async function editText(note: UserNote, text: string) {
    if (text === note.text) return;
    const prev = notes;
    setNotes((cur) => (cur ?? []).map((n) => (n.id === note.id ? { ...n, text } : n)));
    setError(null);
    try {
      const res = await fetch(`/api/my-work/notes/${note.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update note.");
    } catch (err) {
      setNotes(prev);
      setError(err instanceof Error ? err.message : "Could not update note.");
    }
  }

  async function removeNote(id: string) {
    const prev = notes;
    setNotes((cur) => (cur ?? []).filter((n) => n.id !== id));
    setError(null);
    try {
      const res = await fetch(`/api/my-work/notes/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Could not remove note.");
    } catch (err) {
      setNotes(prev);
      setError(err instanceof Error ? err.message : "Could not remove note.");
    }
  }

  const active = (notes ?? []).filter((n) => !n.done);
  const done = (notes ?? []).filter((n) => n.done);

  return (
    <aside className="h-fit border border-[#dcd6cc] bg-offwhite p-4">
      <p className="label-caps mb-3 !text-sand">Notes</p>

      <form onSubmit={addNote} className="mb-4 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a note…"
          className="min-w-0 flex-1 border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
        <button
          type="submit"
          disabled={adding || !draft.trim()}
          className="shrink-0 bg-nearblack px-3 py-1.5 text-caption text-white hover:bg-charcoal disabled:opacity-60"
        >
          Add
        </button>
      </form>

      {error && <p className="mb-3 text-caption text-red-700">{error}</p>}

      {notes === null ? (
        <p className="text-caption text-charcoal/40">Loading…</p>
      ) : (
        <>
          {active.length === 0 && done.length === 0 && (
            <p className="text-caption text-charcoal/40">No notes yet.</p>
          )}
          <ul className="space-y-1">
            {active.map((n) => (
              <NoteRow key={n.id} note={n} onToggle={() => toggleDone(n)} onEdit={(t) => editText(n, t)} onRemove={() => removeNote(n.id)} />
            ))}
          </ul>
          {done.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-caption text-charcoal/40">Done · {done.length}</summary>
              <ul className="mt-2 space-y-1">
                {done.map((n) => (
                  <NoteRow key={n.id} note={n} onToggle={() => toggleDone(n)} onEdit={(t) => editText(n, t)} onRemove={() => removeNote(n.id)} />
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </aside>
  );
}

function NoteRow({
  note,
  onToggle,
  onEdit,
  onRemove,
}: {
  note: UserNote;
  onToggle: () => void;
  onEdit: (text: string) => void;
  onRemove: () => void;
}) {
  return (
    <li className="group flex items-start gap-2 py-1">
      <input
        type="checkbox"
        checked={note.done}
        onChange={onToggle}
        className="mt-1 h-3.5 w-3.5 shrink-0 border-[#c9c2b4]"
      />
      <input
        defaultValue={note.text}
        onBlur={(e) => onEdit(e.target.value.trim() || note.text)}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className={clsx(
          "min-w-0 flex-1 border-none bg-transparent px-0 py-0.5 text-body focus:outline-none",
          note.done ? "text-charcoal/40 line-through" : "text-charcoal/85"
        )}
      />
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 text-caption text-charcoal/25 opacity-0 group-hover:opacity-100 hover:text-red-700"
      >
        ✕
      </button>
    </li>
  );
}
