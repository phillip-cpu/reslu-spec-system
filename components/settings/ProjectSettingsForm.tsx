"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Project } from "@/types";
import { regenerateProjectToken } from "@/app/(dashboard)/projects/[id]/settings/actions";

interface Props {
  project: Project;
  isAdmin: boolean;
  appUrl: string;
}

/**
 * Project Settings (Week 4 task): "audit what exists; ensure: project
 * fields edit, monday_board_id field, client portal link display +
 * copy + regenerate token (regenerate = new client_token, admin-only,
 * existing API? check), archive project (admin-only)."
 *
 * Audit result: no /projects/[id]/settings page existed at all before
 * this — the register page (app/(dashboard)/projects/[id]/page.tsx,
 * outside this build's file boundary) already has an inline
 * MondayBoardPicker, so that field is included here too for a single
 * consolidated settings surface, writing through the same
 * PUT /api/projects/[id] route. No existing "regenerate token" API —
 * see actions.ts for why that one specific action is a server action
 * rather than a new REST route.
 *
 * Field edits (name, client_name, address, budget) and monday_board_id
 * go through the existing PUT /api/projects/[id] (unmodified — that
 * file is outside this boundary). Archive goes through the existing
 * DELETE /api/projects/[id] (also unmodified; it already archives
 * rather than hard-deleting).
 */
export function ProjectSettingsForm({ project, isAdmin, appUrl }: Props) {
  const router = useRouter();

  const [name, setName] = useState(project.name);
  const [clientName, setClientName] = useState(project.client_name);
  const [address, setAddress] = useState(project.address ?? "");
  const [budget, setBudget] = useState(project.budget?.toString() ?? "");
  const [mondayBoardId, setMondayBoardId] = useState(project.monday_board_id ?? "");
  const [token, setToken] = useState(project.client_token);

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [regenerating, setRegenerating] = useState(false);
  const [archiving, setArchiving] = useState(false);

  const portalLink = `${appUrl.replace(/\/+$/, "")}/portal/${token}`;

  async function saveFields(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          client_name: clientName.trim(),
          address: address.trim() || null,
          budget: budget.trim() === "" ? null : Number(budget),
          monday_board_id: mondayBoardId.trim() || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      setSavedAt(Date.now());
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setSaving(false);
    }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(portalLink);
      setCopyLabel("Copied");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    } catch {
      setCopyLabel("Could not copy");
      setTimeout(() => setCopyLabel("Copy link"), 1500);
    }
  }

  async function regenerate() {
    if (
      !confirm(
        "Regenerate the client portal link? The old link will stop working immediately."
      )
    )
      return;
    setRegenerating(true);
    setError(null);
    try {
      const result = await regenerateProjectToken(project.id);
      if (!result.ok) throw new Error(result.error);
      setToken(result.token);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not regenerate link");
    } finally {
      setRegenerating(false);
    }
  }

  async function archive() {
    if (
      !confirm(
        `Archive "${project.name}"? It will be hidden from the active project list. This can be reversed later from Supabase if needed.`
      )
    )
      return;
    setArchiving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not archive");
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive");
      setArchiving(false);
    }
  }

  return (
    <div className="max-w-2xl space-y-10">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">
          {error}
        </p>
      )}

      <form onSubmit={saveFields} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="label-caps">Project name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={!isAdmin}
              className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-caps">Client name</span>
            <input
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              disabled={!isAdmin}
              className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="label-caps">Address</span>
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            disabled={!isAdmin}
            className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
          />
        </label>

        <div className="grid grid-cols-2 gap-4">
          <label className="flex flex-col gap-1">
            <span className="label-caps">Budget (ex GST)</span>
            <input
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              disabled={!isAdmin}
              inputMode="decimal"
              className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="label-caps">Monday.com board ID</span>
            <input
              value={mondayBoardId}
              onChange={(e) => setMondayBoardId(e.target.value)}
              disabled={!isAdmin}
              placeholder="Not linked"
              className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
            />
          </label>
        </div>

        {isAdmin && (
          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={saving}
              className="bg-nearblack px-5 py-2 text-subhead text-white hover:bg-charcoal disabled:opacity-60"
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
            {savedAt && (
              <span className="text-caption text-charcoal/50">Saved</span>
            )}
          </div>
        )}
      </form>

      <div className="space-y-3 border-t border-[#dcd6cc] pt-8">
        <h3 className="text-subhead text-nearblack">Client portal</h3>
        <p className="text-body text-charcoal/60">
          The client uses this link to view the register and approve or flag
          items. It never shows pricing or ordering data.
        </p>
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={portalLink}
            className="flex-1 border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body text-charcoal/70"
          />
          <button
            type="button"
            onClick={copyLink}
            className="border border-nearblack px-4 py-2 text-subhead text-nearblack hover:bg-nearblack hover:text-white"
          >
            {copyLabel}
          </button>
        </div>
        {isAdmin && (
          <button
            type="button"
            onClick={regenerate}
            disabled={regenerating}
            className="text-caption text-charcoal/60 underline hover:text-red-700 disabled:opacity-60"
          >
            {regenerating ? "Regenerating…" : "Regenerate link (invalidates the old one)"}
          </button>
        )}
      </div>

      {isAdmin && (
        <div className="space-y-3 border-t border-[#dcd6cc] pt-8">
          <h3 className="text-subhead text-nearblack">Archive project</h3>
          <p className="text-body text-charcoal/60">
            Archiving hides the project from the active list. Items and history
            are kept.
          </p>
          <button
            type="button"
            onClick={archive}
            disabled={archiving}
            className="border border-red-700 px-4 py-2 text-subhead text-red-700 hover:bg-red-700 hover:text-white disabled:opacity-60"
          >
            {archiving ? "Archiving…" : "Archive project"}
          </button>
        </div>
      )}
    </div>
  );
}
