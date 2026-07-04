"use client";

import { useState } from "react";
import type { RoomWithCount } from "@/types";

/**
 * Room builder — lay out a project's rooms up front (before assigning items).
 * Create, rename and delete rooms; shows how many items each holds. Sits at
 * the top of the spec register and is backed by the same rooms the FF&E
 * assignment + per-room PDF use (and, later, the SOW builder). Project-scoped
 * via /api/projects/[id]/rooms and /api/rooms/[id].
 */
export function RoomBuilder({
  projectId,
  rooms,
  onChanged,
  onError,
}: {
  projectId: string;
  rooms: RoomWithCount[];
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");

  async function addRoom() {
    const n = name.trim();
    if (!n || busy) return;
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not add room");
      setName("");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not add room");
    } finally {
      setBusy(false);
    }
  }

  async function rename(id: string) {
    const n = editName.trim();
    setEditingId(null);
    const current = rooms.find((r) => r.id === id);
    if (!n || !current || n === current.name) return;
    onError(null);
    try {
      const res = await fetch(`/api/rooms/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: n }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not rename room");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not rename room");
    }
  }

  async function remove(room: RoomWithCount) {
    const msg =
      room.item_count > 0
        ? `Delete "${room.name}"? It has ${room.item_count} item(s) assigned — they stay in the register but lose this room.`
        : `Delete room "${room.name}"?`;
    if (!confirm(msg)) return;
    onError(null);
    try {
      const res = await fetch(`/api/rooms/${room.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not delete room");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not delete room");
    }
  }

  return (
    <div className="border border-[#dcd6cc] bg-cream/40 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="label-caps !text-nearblack">Rooms</span>
        <span className="text-caption text-charcoal/40">
          {rooms.length === 0 ? "none yet — add your rooms to start" : `${rooms.length}`}
        </span>

        {rooms.map((r) => (
          <span
            key={r.id}
            className="inline-flex items-center gap-1.5 border border-[#c9c2b4] bg-nearwhite px-2 py-1"
          >
            {editingId === r.id ? (
              <input
                autoFocus
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onBlur={() => rename(r.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  if (e.key === "Escape") setEditingId(null);
                }}
                className="w-24 border-b border-nearblack bg-transparent text-body focus:outline-none"
              />
            ) : (
              <button
                type="button"
                onClick={() => {
                  setEditingId(r.id);
                  setEditName(r.name);
                }}
                title="Click to rename"
                className="text-body text-nearblack hover:underline"
              >
                {r.name}
              </button>
            )}
            <span className="text-caption text-charcoal/40">{r.item_count}</span>
            <button
              type="button"
              onClick={() => remove(r)}
              aria-label={`Delete ${r.name}`}
              className="text-caption text-charcoal/40 hover:text-red-700"
            >
              ×
            </button>
          </span>
        ))}

        <div className="flex items-center gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRoom();
              }
            }}
            placeholder="New room name…"
            className="w-36 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />
          <button
            type="button"
            disabled={!name.trim() || busy}
            onClick={addRoom}
            className="border border-nearblack px-3 py-1 text-subhead text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-40"
          >
            {busy ? "Adding…" : "+ Add room"}
          </button>
        </div>
      </div>
    </div>
  );
}
