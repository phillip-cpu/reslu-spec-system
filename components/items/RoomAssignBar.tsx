"use client";

import { useEffect, useState } from "react";
import type { RoomWithCount } from "@/types";

/**
 * Sticky bulk-action bar shown on the spec register when one or more items
 * are selected. Lets the team assign the selected items to one or more
 * rooms with a per-room quantity (add or replace mode), and create rooms
 * inline. Backed by:
 *   GET/POST /api/projects/[id]/rooms
 *   POST     /api/projects/[id]/items/rooms  (bulk assign)
 */
export function RoomAssignBar({
  projectId,
  selectedItemIds,
  onClear,
  onError,
}: {
  projectId: string;
  selectedItemIds: string[];
  onClear: () => void;
  onError: (msg: string | null) => void;
}) {
  const [rooms, setRooms] = useState<RoomWithCount[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [quantity, setQuantity] = useState("1");
  const [mode, setMode] = useState<"add" | "replace">("add");
  const [newRoom, setNewRoom] = useState("");
  const [creating, setCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let live = true;
    fetch(`/api/projects/${projectId}/rooms`)
      .then((r) => r.json())
      .then((d) => {
        if (live && Array.isArray(d.rooms)) setRooms(d.rooms);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);

  function toggleRoom(id: string) {
    setChosen((cur) => {
      const next = new Set(cur);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function createRoom() {
    const name = newRoom.trim();
    if (!name || creating) return;
    setCreating(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not create room");
      setRooms((cur) => [...cur, { ...d.room, item_count: 0 }]);
      setChosen((cur) => new Set(cur).add(d.room.id));
      setNewRoom("");
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create room");
    } finally {
      setCreating(false);
    }
  }

  async function assign() {
    if (chosen.size === 0 || submitting) return;
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      onError("Quantity must be a non-negative number.");
      return;
    }
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/items/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          item_ids: selectedItemIds,
          room_ids: [...chosen],
          quantity: qty,
          mode,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not assign rooms");
      setChosen(new Set());
      onClear();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not assign rooms");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="sticky bottom-0 z-20 -mx-2 mt-4 border-t-2 border-nearblack bg-cream/95 px-4 py-3 shadow-[0_-4px_16px_rgba(0,0,0,0.06)] backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="text-subhead font-medium text-nearblack">
          {selectedItemIds.length} selected
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-caption text-charcoal/50 hover:text-nearblack"
        >
          Clear
        </button>

        <span className="text-charcoal/30">·</span>
        <span className="label-caps">Assign to</span>

        {/* Room chips */}
        <div className="flex flex-wrap items-center gap-1.5">
          {rooms.length === 0 && (
            <span className="text-caption text-charcoal/40">No rooms yet — add one →</span>
          )}
          {rooms.map((r) => {
            const on = chosen.has(r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => toggleRoom(r.id)}
                className={
                  "border px-2.5 py-1 text-caption transition-colors " +
                  (on
                    ? "border-nearblack bg-nearblack text-white"
                    : "border-[#c9c2b4] text-nearblack hover:border-nearblack")
                }
              >
                {r.name}
              </button>
            );
          })}
        </div>

        {/* Add room inline */}
        <div className="flex items-center gap-1">
          <input
            value={newRoom}
            onChange={(e) => setNewRoom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                createRoom();
              }
            }}
            placeholder="New room name…"
            className="w-32 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-caption focus:border-nearblack focus:outline-none"
          />
          <button
            type="button"
            disabled={!newRoom.trim() || creating}
            onClick={createRoom}
            className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-40"
          >
            {creating ? "Adding…" : "+ Add room"}
          </button>
        </div>

        <span className="text-charcoal/30">·</span>

        {/* Quantity per room */}
        <label className="flex items-center gap-1.5">
          <span className="label-caps">Qty / room</span>
          <input
            value={quantity}
            onChange={(e) => setQuantity(e.target.value)}
            inputMode="decimal"
            className="w-16 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />
        </label>

        {/* Mode */}
        <div className="flex border border-[#c9c2b4]">
          {(["add", "replace"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              title={
                m === "add"
                  ? "Add to these rooms, keep existing room assignments"
                  : "Replace: these items' rooms become exactly the chosen ones"
              }
              className={
                "px-2.5 py-1 text-caption " +
                (mode === m ? "bg-nearblack text-white" : "text-nearblack hover:bg-cream")
              }
            >
              {m === "add" ? "Add" : "Replace"}
            </button>
          ))}
        </div>

        <button
          type="button"
          disabled={submitting || chosen.size === 0}
          onClick={assign}
          className="ml-auto bg-nearblack px-4 py-1.5 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-50"
        >
          {submitting ? "Assigning…" : "Assign to rooms"}
        </button>
      </div>
    </div>
  );
}
