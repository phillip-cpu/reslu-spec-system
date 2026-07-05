"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import type { ProjectWithAlias } from "@/types/phase-12a-b";
import { regenerateProjectToken } from "@/app/(dashboard)/projects/[id]/settings/actions";

interface Props {
  project: ProjectWithAlias;
  isAdmin: boolean;
  appUrl: string;
  /** Week 7 — signed URL for the current cover image, minted server-side by the settings page (assets bucket is private). */
  initialCoverImageUrl: string | null;
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
 *
 * Phase 11 extension — "Client contacts" group (5 July 2026, Phillip):
 * client_email + notify_client (migration 016_portal_v2.sql) were
 * added to the schema in Phase 11B but never surfaced on this form —
 * audited via grep across app/+components/ before building (see this
 * task's verification notes): no other UI wrote to either column, so
 * both are net-new fields here, not a duplicate surface. client_phone
 * + client_secondary_name/_email/_phone (migration
 * 017_project_contacts.sql) are net-new for the second owner on a
 * couple's job. All six save through the same PUT /api/projects/[id]
 * (unmodified — it already accepts any Partial<Project> body), in the
 * same saveFields() submit as the existing fields above.
 */
export function ProjectSettingsForm({ project, isAdmin, appUrl, initialCoverImageUrl }: Props) {
  const router = useRouter();

  const [name, setName] = useState(project.name);
  // Housekeeping (Phase 12a-B) — BUILD-SPEC.md §"Housekeeping — 5 July
  // screenshot" point 2: internal-only nickname, e.g. "Nth Adelaide
  // townhouse". NEVER read by the portal or the schedule PDF — both
  // keep using project.name exclusively.
  const [alias, setAlias] = useState(project.alias ?? "");
  const [clientName, setClientName] = useState(project.client_name);
  const [address, setAddress] = useState(project.address ?? "");
  const [budget, setBudget] = useState(project.budget?.toString() ?? "");
  const [mondayBoardId, setMondayBoardId] = useState(project.monday_board_id ?? "");
  const [token, setToken] = useState(project.client_token);

  // Phase 11 extension — Client contacts group (see doc comment above).
  const [clientEmail, setClientEmail] = useState(project.client_email ?? "");
  const [notifyClient, setNotifyClient] = useState(project.notify_client);
  const [clientPhone, setClientPhone] = useState(project.client_phone ?? "");
  const [secondaryName, setSecondaryName] = useState(project.client_secondary_name ?? "");
  const [secondaryEmail, setSecondaryEmail] = useState(project.client_secondary_email ?? "");
  const [secondaryPhone, setSecondaryPhone] = useState(project.client_secondary_phone ?? "");

  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyLabel, setCopyLabel] = useState("Copy link");
  const [regenerating, setRegenerating] = useState(false);
  const [archiving, setArchiving] = useState(false);

  // Cover image (Week 7) — BUILD-SPEC.md "Project cover image".
  const [coverImageUrl, setCoverImageUrl] = useState(initialCoverImageUrl);
  const [uploadingCover, setUploadingCover] = useState(false);
  const [removingCover, setRemovingCover] = useState(false);
  const coverInput = useRef<HTMLInputElement>(null);

  async function uploadCover(file: File) {
    setUploadingCover(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/projects/${project.id}/cover`, {
        method: "POST",
        body: fd,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Cover image upload failed");
      setCoverImageUrl(body.url ?? null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cover image upload failed");
    } finally {
      setUploadingCover(false);
      if (coverInput.current) coverInput.current.value = "";
    }
  }

  async function removeCover() {
    if (!confirm("Remove the project cover image?")) return;
    setRemovingCover(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/cover`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not remove cover image");
      setCoverImageUrl(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not remove cover image");
    } finally {
      setRemovingCover(false);
    }
  }

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
          alias: alias.trim() || null,
          client_name: clientName.trim(),
          address: address.trim() || null,
          budget: budget.trim() === "" ? null : Number(budget),
          monday_board_id: mondayBoardId.trim() || null,
          // Phase 11 extension — Client contacts group.
          client_email: clientEmail.trim() || null,
          notify_client: notifyClient,
          client_phone: clientPhone.trim() || null,
          client_secondary_name: secondaryName.trim() || null,
          client_secondary_email: secondaryEmail.trim() || null,
          client_secondary_phone: secondaryPhone.trim() || null,
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

      <div className="space-y-3">
        <h3 className="text-subhead text-nearblack">Cover image</h3>
        <p className="text-body text-charcoal/60">
          Shown on the dashboard project card and next to the project name.
        </p>
        <div className="flex items-start gap-4">
          <div className="relative aspect-[3/2] w-48 shrink-0 overflow-hidden border border-[#dcd6cc] bg-cream">
            {coverImageUrl ? (
              <Image src={coverImageUrl} alt="" fill sizes="192px" className="object-cover" />
            ) : (
              <span className="flex h-full w-full items-center justify-center text-caption text-charcoal/25">
                No cover image
              </span>
            )}
          </div>
          <div className="space-y-2">
            <input
              ref={coverInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) uploadCover(f);
              }}
            />
            <button
              type="button"
              disabled={uploadingCover}
              onClick={() => coverInput.current?.click()}
              className="border border-nearblack px-3 py-1.5 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-60"
            >
              {uploadingCover ? "Uploading…" : coverImageUrl ? "Replace image" : "Upload image"}
            </button>
            {coverImageUrl && (
              <button
                type="button"
                disabled={removingCover}
                onClick={removeCover}
                className="block text-caption text-charcoal/50 hover:text-red-700 disabled:opacity-60"
              >
                {removingCover ? "Removing…" : "Remove image"}
              </button>
            )}
            <p className="text-caption text-charcoal/40">JPG, PNG or WebP, up to 10MB.</p>
          </div>
        </div>
      </div>

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
          <span className="label-caps">Alias (internal only)</span>
          <input
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={!isAdmin}
            placeholder="e.g. Nth Adelaide townhouse"
            className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
          />
          <span className="text-caption text-charcoal/40">
            Shown on the dashboard card, this project&apos;s header, and My Work — never on the client portal or PDFs.
          </span>
        </label>

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

        {/* Phase 11 extension — Client contacts (5 July 2026, Phillip):
            primary email/phone + a second owner's name/email/phone for
            couples. Saves through the same submit as every other field
            on this form (single PUT /api/projects/[id]). */}
        <div className="space-y-4 border-t border-[#dcd6cc] pt-6">
          <h3 className="text-subhead text-nearblack">Client contacts</h3>
          <p className="text-body text-charcoal/60">
            Used for the client portal link and for RESLU&apos;s email
            notifications (diary updates, shared documents, signature
            requests, variations). Never shown to anyone but the RESLU
            team.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <label className="flex flex-col gap-1">
              <span className="label-caps">Primary email</span>
              <input
                type="email"
                value={clientEmail}
                onChange={(e) => setClientEmail(e.target.value)}
                disabled={!isAdmin}
                placeholder="client@example.com"
                className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="label-caps">Primary phone</span>
              <input
                type="tel"
                value={clientPhone}
                onChange={(e) => setClientPhone(e.target.value)}
                disabled={!isAdmin}
                className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
              />
            </label>
          </div>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={notifyClient}
              onChange={(e) => setNotifyClient(e.target.checked)}
              disabled={!isAdmin}
              className="h-4 w-4 border-[#c9c2b4] disabled:opacity-60"
            />
            <span className="label-caps">Email the client on updates</span>
          </label>

          <div className="border-t border-[#e5e0d6] pt-4">
            <p className="label-caps mb-3">Second owner (optional)</p>
            <div className="grid grid-cols-2 gap-4">
              <label className="flex flex-col gap-1 col-span-2">
                <span className="label-caps">Name</span>
                <input
                  value={secondaryName}
                  onChange={(e) => setSecondaryName(e.target.value)}
                  disabled={!isAdmin}
                  className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-caps">Email</span>
                <input
                  type="email"
                  value={secondaryEmail}
                  onChange={(e) => setSecondaryEmail(e.target.value)}
                  disabled={!isAdmin}
                  placeholder="client@example.com"
                  className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="label-caps">Phone</span>
                <input
                  type="tel"
                  value={secondaryPhone}
                  onChange={(e) => setSecondaryPhone(e.target.value)}
                  disabled={!isAdmin}
                  className="border border-[#c9c2b4] bg-nearwhite px-3 py-2 text-body focus:border-nearblack focus:outline-none disabled:opacity-60"
                />
              </label>
            </div>
            {secondaryEmail.trim() && (
              <p className="mt-2 text-caption text-charcoal/40">
                Both owners will be copied on the same email notification.
              </p>
            )}
          </div>
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
