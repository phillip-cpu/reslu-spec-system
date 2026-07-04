"use client";

import { useState } from "react";
import clsx from "clsx";

interface UpdateRow {
  id: string;
  title: string;
  published_at: string | null;
  created_at: string;
}

/**
 * Write/publish updates panel (BUILD-SPEC.md "Team-side client area":
 * "write/publish updates (textarea markdown, publish button, draft
 * list)"). Team-authenticated. The portal's UpdatesFeed renders the
 * same body_richtext through lib/simple-markdown.tsx — this panel's
 * textarea is plain text input (markdown source), no editor/preview
 * dependency beyond a "Preview" toggle using that same renderer.
 */
export function UpdatesPanel({
  projectId,
  initialUpdates,
  onChange,
}: {
  projectId: string;
  initialUpdates: UpdateRow[];
  onChange: () => void;
}) {
  const [updates, setUpdates] = useState(initialUpdates);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function createDraft() {
    if (!title.trim() || !body.trim()) {
      setError("Title and body are required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), body_richtext: body.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not save draft");
      const { update } = await res.json();
      setUpdates((cur) => [update, ...cur]);
      setTitle("");
      setBody("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save draft");
    } finally {
      setSaving(false);
    }
  }

  async function publish(id: string, publish: boolean) {
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-updates/posts/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publish }),
      });
      if (!res.ok) throw new Error((await res.json()).error ?? "Could not update");
      const { update } = await res.json();
      setUpdates((cur) => cur.map((u) => (u.id === id ? update : u)));
      onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update");
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
      setError("Could not remove update.");
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <div className="space-y-2 border border-[#dcd6cc] bg-nearwhite p-4">
        <p className="label-caps !text-sand">New update</p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Write the update. Supports **bold** and - bullet lists."
          rows={6}
          className="w-full border border-[#c9c2b4] bg-white px-3 py-2 text-body focus:border-nearblack focus:outline-none"
        />
        <button
          type="button"
          disabled={saving}
          onClick={createDraft}
          className="bg-nearblack px-4 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {saving ? "Saving…" : "Save draft"}
        </button>
      </div>

      <div>
        <p className="label-caps mb-2 !text-sand">All updates</p>
        {updates.length === 0 ? (
          <p className="text-body text-charcoal/50">No updates yet.</p>
        ) : (
          <ul className="space-y-2">
            {updates.map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-3 border border-[#e5e0d6] bg-nearwhite px-4 py-3">
                <div>
                  <p className="text-subhead text-nearblack">{u.title}</p>
                  <span
                    className={clsx(
                      "label-caps",
                      u.published_at ? "!text-sand" : "!text-charcoal/40"
                    )}
                  >
                    {u.published_at ? "Published" : "Draft"}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {u.published_at ? (
                    <button
                      type="button"
                      onClick={() => publish(u.id, false)}
                      className="text-caption text-charcoal/50 underline hover:text-nearblack"
                    >
                      Unpublish
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => publish(u.id, true)}
                      className="border border-nearblack px-3 py-1.5 text-caption text-nearblack hover:bg-nearblack hover:text-white"
                    >
                      Publish
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => remove(u.id)}
                    className="text-caption text-charcoal/50 hover:text-red-700"
                  >
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
