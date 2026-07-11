"use client";

import { useRef, useState } from "react";

/**
 * /trade/[token] capture section — Site capture + mobile QoL round
 * (r21), BUILD-SPEC.md item 1b: "trade can drop photos/notes onto the
 * job they're booked on; author recorded as the contact." Posts to
 * POST /api/trade/[token]/captures — no new token infra, the SAME
 * confirm_token this whole page already renders under (see that
 * route's own doc comment: project_id/trade_visit_id/
 * author_contact_id are all resolved server-side from the visit the
 * token identifies, never client-supplied here).
 *
 * Deliberately photo + text note ONLY — no hold-to-record audio button
 * (unlike /capture's NoteComposer, components/capture/NoteComposer.tsx).
 * BUILD-SPEC's own wording for this entry point names "photos/notes"
 * specifically (not audio), and keeping this public, unauthenticated
 * page's JS surface smaller — one fewer getUserMedia microphone
 * permission prompt on a page a trade contact opens from an SMS/email
 * link, possibly for the first time — is a deliberate scope choice for
 * this entry point. The API (POST /api/trade/[token]/captures) DOES
 * already accept kind='audio' multipart uploads if a future round
 * wants to add the same hold-to-record button here.
 */
export function TradeCaptureSection({ token }: { token: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoProgress, setPhotoProgress] = useState<{ done: number; total: number } | null>(null);
  const [text, setText] = useState("");
  const [postingNote, setPostingNote] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  async function uploadPhotos(files: File[]) {
    if (files.length === 0) return;
    setUploadingPhoto(true);
    setError(null);
    setPhotoProgress({ done: 0, total: files.length });

    for (const file of files) {
      try {
        const form = new FormData();
        form.append("kind", "photo");
        form.append("file", file);
        const res = await fetch(`/api/trade/${token}/captures`, { method: "POST", body: form });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed.");
        }
        setSentCount((n) => n + 1);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setPhotoProgress((prev) => (prev ? { done: prev.done + 1, total: prev.total } : null));
      }
    }

    setUploadingPhoto(false);
    setPhotoProgress(null);
  }

  async function postNote() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPostingNote(true);
    setError(null);
    try {
      const res = await fetch(`/api/trade/${token}/captures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", text_content: trimmed }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? "Could not send note.");
      }
      setText("");
      setSentCount((n) => n + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send note.");
    } finally {
      setPostingNote(false);
    }
  }

  return (
    <div className="border border-[#dcd6cc] bg-offwhite px-4 py-4">
      <p className="label-caps mb-3">Drop a photo or note</p>

      <button
        type="button"
        disabled={uploadingPhoto}
        onClick={() => inputRef.current?.click()}
        className="w-full bg-nearblack px-4 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
      >
        {uploadingPhoto && photoProgress
          ? `Uploading ${Math.min(photoProgress.done + 1, photoProgress.total)} of ${photoProgress.total}…`
          : "Take / upload photo"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          void uploadPhotos(files);
        }}
      />

      <div className="mt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="Type a note for the office…"
          className="w-full border border-[#c9c2b4] bg-nearwhite px-3 py-3 text-body text-nearblack focus:border-nearblack focus:outline-none"
        />
        <p className="mt-1 text-caption text-charcoal/50">Tap the mic on your keyboard to dictate.</p>
        <button
          type="button"
          onClick={postNote}
          disabled={postingNote || !text.trim()}
          className="mt-2 w-full border border-nearblack px-4 py-3 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
        >
          {postingNote ? "Sending…" : "Send note"}
        </button>
      </div>

      {sentCount > 0 && <p className="mt-3 text-caption text-charcoal/60">Sent {sentCount} to the office so far.</p>}
      {error && <p className="mt-3 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}
    </div>
  );
}
