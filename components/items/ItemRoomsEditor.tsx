"use client";

import { useState } from "react";
import type { ItemRoomAllocation, RoomWithCount } from "@/types";

/**
 * Per-item room allocations, shown in an item's expanded detail. Add the
 * item to one or more rooms, each with its own quantity (e.g. an item of
 * qty 2 → Ensuite 1 + Bathroom 1). Backed by:
 *   POST   /api/projects/[id]/items/rooms  (upsert one item/room at qty)
 *   DELETE /api/projects/[id]/items/rooms  (remove one allocation)
 * onChanged() tells the workspace to refetch allocations so grouping and
 * the per-room totals stay in sync.
 */
export function ItemRoomsEditor({
  projectId,
  itemId,
  itemQuantity,
  rooms,
  allocations,
  onChanged,
  onError,
}: {
  projectId: string;
  itemId: string;
  itemQuantity: number;
  rooms: RoomWithCount[];
  allocations: ItemRoomAllocation[];
  onChanged: () => void;
  onError: (msg: string | null) => void;
}) {
  const [addRoom, setAddRoom] = useState("");
  const [addQty, setAddQty] = useState("1");
  const [busy, setBusy] = useState(false);

  const assignedRoomIds = new Set(allocations.map((a) => a.room_id));
  const available = rooms.filter((r) => !assignedRoomIds.has(r.id));
  const allocatedTotal = allocations.reduce((s, a) => s + Number(a.quantity || 0), 0);

  async function setAllocation(roomId: string, quantity: number) {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/items/rooms`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_ids: [itemId], room_ids: [roomId], quantity, mode: "add" }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update room");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not update room");
    } finally {
      setBusy(false);
    }
  }

  async function removeAllocation(roomId: string) {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/items/rooms`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item_id: itemId, room_id: roomId }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not remove room");
      onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not remove room");
    } finally {
      setBusy(false);
    }
  }

  async function addAllocation() {
    if (!addRoom || busy) return;
    const q = Number(addQty);
    if (!Number.isFinite(q) || q < 0) {
      onError("Quantity must be a non-negative number.");
      return;
    }
    await setAllocation(addRoom, q);
    setAddRoom("");
    setAddQty("1");
  }

  return (
    <div>
      <p className="label-caps mb-1.5">Rooms</p>

      {allocations.length === 0 ? (
        <p className="mb-2 text-caption text-charcoal/40">Not assigned to any room yet.</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {allocations.map((a) => (
            <li key={a.room_id} className="flex items-center gap-2">
              <span className="min-w-[90px] text-body text-nearblack">{a.room_name}</span>
              <input
                type="text"
                inputMode="decimal"
                defaultValue={String(a.quantity)}
                disabled={busy}
                onBlur={(e) => {
                  const q = Number(e.target.value);
                  if (Number.isFinite(q) && q >= 0 && q !== a.quantity) setAllocation(a.room_id, q);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                }}
                className="w-16 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
              />
              <span className="text-caption text-charcoal/40">in {a.room_name}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => removeAllocation(a.room_id)}
                className="text-caption text-charcoal/50 hover:text-red-700"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}

      {allocations.length > 0 && allocatedTotal !== itemQuantity && (
        <p className="mb-2 text-caption text-amber-700">
          Room quantities total {allocatedTotal}, but this item&apos;s Qty is {itemQuantity}.
        </p>
      )}

      {available.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={addRoom}
            onChange={(e) => setAddRoom(e.target.value)}
            className="border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          >
            <option value="">Add to room…</option>
            {available.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          <input
            type="text"
            inputMode="decimal"
            value={addQty}
            onChange={(e) => setAddQty(e.target.value)}
            aria-label="Quantity in room"
            className="w-16 border border-[#c9c2b4] bg-nearwhite px-2 py-1 text-body focus:border-nearblack focus:outline-none"
          />
          <button
            type="button"
            disabled={!addRoom || busy}
            onClick={addAllocation}
            className="border border-nearblack px-3 py-1 text-subhead text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-50"
          >
            Add
          </button>
        </div>
      ) : rooms.length === 0 ? (
        <p className="text-caption text-charcoal/40">
          No rooms yet — select items and use the bar below to create one.
        </p>
      ) : (
        <p className="text-caption text-charcoal/40">In every room.</p>
      )}
    </div>
  );
}
