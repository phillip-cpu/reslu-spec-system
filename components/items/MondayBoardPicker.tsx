"use client";

import { useEffect, useState } from "react";
import type { MondayBoard } from "@/lib/monday";

interface Props {
  projectId: string;
  currentBoardId: string | null;
}

export function MondayBoardPicker({ projectId, currentBoardId }: Props) {
  const [boardId, setBoardId] = useState<string>(currentBoardId ?? "");
  const [boards, setBoards] = useState<MondayBoard[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/monday/boards")
      .then((r) => r.json())
      .then((d) => {
        if (!active) return;
        setConfigured(d.configured);
        setBoards(d.boards ?? []);
        if (d.error) setError(d.error);
      })
      .catch(() => active && setConfigured(false));
    return () => {
      active = false;
    };
  }, []);

  async function change(next: string) {
    const prev = boardId;
    setBoardId(next);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ monday_board_id: next || null }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
    } catch (err) {
      setBoardId(prev);
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  if (configured === false) {
    return (
      <span className="label-caps !text-charcoal/40" title="Set MONDAY_API_TOKEN in .env.local">
        Monday not connected
      </span>
    );
  }

  return (
    <label className="flex items-center gap-2" title="Procurement board for status→Ordered sync">
      <span className="label-caps">Monday board</span>
      <select
        value={boardId}
        disabled={configured === null || saving}
        onChange={(e) => change(e.target.value)}
        className="max-w-[220px] border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
      >
        <option value="">
          {configured === null ? "Loading…" : "Not linked"}
        </option>
        {boards.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
      {error && <span className="text-caption text-red-700">{error}</span>}
    </label>
  );
}
