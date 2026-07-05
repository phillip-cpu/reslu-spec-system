"use client";

import { useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import { GalleryUploader, type SitePhoto } from "@/components/gallery/GalleryUploader";

export interface DiaryPhoto {
  id: string;
  url: string | null;
  caption: string | null;
}

export interface DiaryUpdateRow {
  id: string;
  title: string;
  body_richtext: string;
  status: "draft" | "pending_approval" | "published";
  draft_source: "manual" | "aria";
  published_at: string | null;
  created_at: string;
  photos: DiaryPhoto[];
}

/**
 * Diary — phone-first composer + draft/approval list (BUILD-SPEC.md
 * §"Phase 11 — Diary" + §"mobile pass", the single highest-priority
 * mobile surface: "updates will mainly be written on phones ...
 * camera/gallery pick first, then one big rough-notes textarea
 * (dictation-friendly, no formatting toolbar), one tap to send to
 * Aria, and the approve-to-publish step must also be a single tap from
 * a phone").
 *
 * Pipeline end-to-end:
 *   1. Staff picks 1-2 photos (camera-direct or gallery) + writes rough
 *      notes in ONE plain textarea -> "Send to Aria" saves a
 *      portal_updates row (status 'draft', draft_source 'manual') with
 *      the photos linked via portal_update_photos.
 *   2. Aria (external MCP tool draft_diary_entry, run on her own
 *      schedule/prompting — nothing in this UI calls her synchronously)
 *      fetches the draft + photo captions via GET .../aria-draft,
 *      writes a polished title+body, and POSTs it back, which flips
 *      status to 'pending_approval' and draft_source to 'aria'.
 *   3. This panel shows pending_approval entries as an approval card:
 *      the polished draft preview, a single-tap "Publish" button, and
 *      an inline "Edit" toggle (a plain textarea/input overlay — no
 *      rich editor) in case the copy needs a tweak before it goes
 *      live. Publishing is ALWAYS a human action — Aria never flips
 *      status to 'published' herself (see docs/ARIA.md).
 *
 * This same approval card is also meant to surface on the project
 * overview page (BUILD-SPEC.md "approval card in client area AND
 * surfaced on the project overview") — that page/component
 * (app/(dashboard)/projects/[id]/page.tsx, components/projects/**) is
 * outside this agent's boundary (Week 8A's), so this panel is built as
 * a standalone, reusable component (DiaryApprovalCard, exported below)
 * that the overview hub can drop in later; wiring it into the overview
 * page itself is a follow-up noted in this task's final report,
 * exactly like the existing "Client area not linked from ProjectTabs"
 * precedent from Week 8B.
 */
export function DiaryPanel({
  projectId,
  initialUpdates,
  onChange,
}: {
  projectId: string;
  initialUpdates: DiaryUpdateRow[];
  onChange: () => void;
}) {
  const [updates, setUpdates] = useState(initialUpdates);
  const [notes, setNotes] = useState("");
  const [pendingPhotos, setPendingPhotos] = useState<SitePhoto[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendToAria() {
    if (!notes.trim() && pendingPhotos.length === 0) {
      setError("Add a photo or a few rough notes first.");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Site update",
          body_richtext: notes.trim(),
          photo_ids: pendingPhotos.map((p) => p.id),
        }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not send to Aria");
      setNotes("");
      setPendingPhotos([]);
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send to Aria");
    } finally {
      setSending(false);
    }
  }

  async function publish(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: true }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not publish");
      const { update } = await res.json();
      setUpdates((cur) => cur.map((u) => (u.id === id ? { ...u, ...update } : u)));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish");
    }
  }

  async function saveEdit(id: string, title: string, body: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body_richtext: body }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save");
      const { update } = await res.json();
      setUpdates((cur) => cur.map((u) => (u.id === id ? { ...u, ...update } : u)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  async function unpublish(id: string) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish: false }),
      });
      if (!res.ok) throw new Error("Could not unpublish");
      const { update } = await res.json();
      setUpdates((cur) => cur.map((u) => (u.id === id ? { ...u, ...update } : u)));
      onChange();
    } catch {
      setError("Could not unpublish.");
    }
  }

  async function remove(id: string) {
    const prev = updates;
    setUpdates((cur) => cur.filter((u) => u.id !== id));
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Delete failed");
      onChange();
    } catch {
      setUpdates(prev);
      setError("Could not remove entry.");
    }
  }

  const pendingApproval = updates.filter((u) => u.status === "pending_approval");
  const drafts = updates.filter((u) => u.status === "draft");
  const published = updates.filter((u) => u.status === "published");

  return (
    <div className="space-y-8">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      {/* Phone-first composer — BUILD-SPEC.md "composer is phone-first:
          camera/gallery pick first, then one big rough-notes textarea
          ... one tap to send to Aria." Photo picker comes BEFORE the
          textarea, per spec order. */}
      <div className="space-y-3 border border-[#dcd6cc] bg-nearwhite p-4">
        <p className="label-caps !text-sand">New diary entry</p>

        <GalleryUploader
          projectId={projectId}
          onUploaded={(uploaded) => setPendingPhotos((cur) => [...cur, ...uploaded])}
        />

        {pendingPhotos.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingPhotos.map((p) => (
              <div key={p.id} className="relative h-16 w-16 shrink-0 overflow-hidden border border-[#c9c2b4] bg-cream">
                {p.url && <Image src={p.url} alt="" fill sizes="64px" className="object-cover" />}
                <button
                  type="button"
                  onClick={() => setPendingPhotos((cur) => cur.filter((x) => x.id !== p.id))}
                  className="absolute right-0 top-0 bg-nearblack/70 px-1 text-caption text-white"
                  aria-label="Remove photo"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Rough notes — Aria will write the story"
          rows={6}
          className="w-full border border-[#c9c2b4] bg-white px-3 py-3 text-body focus:border-nearblack focus:outline-none"
        />

        <button
          type="button"
          disabled={sending}
          onClick={sendToAria}
          className="w-full bg-nearblack px-4 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60 sm:w-auto"
        >
          {sending ? "Sending…" : "Send to Aria"}
        </button>
      </div>

      {pendingApproval.length > 0 && (
        <div>
          <p className="label-caps mb-2 !text-sand">Ready to publish</p>
          <div className="space-y-3">
            {pendingApproval.map((u) => (
              <DiaryApprovalCard key={u.id} update={u} onPublish={() => publish(u.id)} onSave={(t, b) => saveEdit(u.id, t, b)} />
            ))}
          </div>
        </div>
      )}

      {drafts.length > 0 && (
        <div>
          <p className="label-caps mb-2 !text-sand">Drafts awaiting Aria</p>
          <ul className="space-y-2">
            {drafts.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 border border-[#e5e0d6] bg-nearwhite px-4 py-3">
                <div>
                  <p className="text-subhead text-nearblack">{u.title}</p>
                  <p className="text-caption text-charcoal/50">{u.photos.length} photo(s) attached</p>
                </div>
                <button type="button" onClick={() => remove(u.id)} className="text-caption text-charcoal/50 hover:text-red-700">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <p className="label-caps mb-2 !text-sand">Published</p>
        {published.length === 0 ? (
          <p className="text-body text-charcoal/50">No entries published yet.</p>
        ) : (
          <ul className="space-y-2">
            {published.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 border border-[#e5e0d6] bg-nearwhite px-4 py-3">
                <p className="text-subhead text-nearblack">{u.title}</p>
                <div className="flex items-center gap-3">
                  <button type="button" onClick={() => unpublish(u.id)} className="text-caption text-charcoal/50 underline hover:text-nearblack">
                    Unpublish
                  </button>
                  <button type="button" onClick={() => remove(u.id)} className="text-caption text-charcoal/50 hover:text-red-700">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Standalone approval card — polished draft preview, single-tap
 * Publish, inline Edit toggle. Exported so the project overview hub
 * (outside this agent's boundary) can reuse it verbatim per
 * BUILD-SPEC.md "approval card in client area AND surfaced on the
 * project overview".
 */
export function DiaryApprovalCard({
  update,
  onPublish,
  onSave,
}: {
  update: DiaryUpdateRow;
  onPublish: () => void;
  onSave: (title: string, body: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(update.title);
  const [body, setBody] = useState(update.body_richtext);
  const [publishing, setPublishing] = useState(false);

  return (
    <div className="border border-sand bg-offwhite p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="label-caps !text-sand">Aria&apos;s draft — ready for your review</span>
        {update.photos.length > 0 && (
          <div className="flex -space-x-2">
            {update.photos.slice(0, 2).map((p) => (
              <div key={p.id} className="relative h-8 w-8 shrink-0 overflow-hidden border-2 border-offwhite bg-cream">
                {p.url && <Image src={p.url} alt="" fill sizes="32px" className="object-cover" />}
              </div>
            ))}
          </div>
        )}
      </div>

      {editing ? (
        <div className="mt-2 space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-white px-3 py-2 font-display text-subhead focus:border-nearblack focus:outline-none"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={6}
            className="w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
          />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => {
                onSave(title, body);
                setEditing(false);
              }}
              className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal"
            >
              Save edit
            </button>
            <button type="button" onClick={() => setEditing(false)} className="px-3 py-2 text-subhead text-charcoal/60 hover:text-nearblack">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <h3 className="mt-2 font-display text-subhead text-nearblack">{update.title}</h3>
          <p className="mt-1 whitespace-pre-wrap text-body text-charcoal/80">{update.body_richtext}</p>
        </>
      )}

      {!editing && (
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            disabled={publishing}
            onClick={() => {
              setPublishing(true);
              onPublish();
            }}
            className={clsx(
              "flex-1 bg-nearblack px-4 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60 sm:flex-none"
            )}
          >
            {publishing ? "Publishing…" : "Publish"}
          </button>
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="border border-nearblack px-4 py-4 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
          >
            Edit
          </button>
        </div>
      )}
    </div>
  );
}
