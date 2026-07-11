"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { SiteCaptureWithUrl } from "@/types/site-captures";

/**
 * Feature-detects a MediaRecorder mimeType this browser can actually
 * record (BUILD-SPEC.md item 2: "feature-detect mimeType support, iOS
 * Safari records audio/mp4"). Tried in preference order: audio/mp4
 * (iOS Safari's ONLY supported recording format — it does not support
 * webm at all), then audio/webm;codecs=opus and plain audio/webm
 * (Chrome/Firefox/Android). Returns null when MediaRecorder itself
 * doesn't exist or none of these are supported — callers must treat
 * null as "hide/disable the record button", never assume support.
 */
function pickAudioMimeType(): string | null {
  if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
  const candidates = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"];
  for (const candidate of candidates) {
    if (typeof MediaRecorder.isTypeSupported === "function" && MediaRecorder.isTypeSupported(candidate)) {
      return candidate;
    }
  }
  return null;
}

const MIN_RECORDING_MS = 400;

/**
 * BUILD-SPEC.md item 2 — "plain textarea (iOS keyboard dictation
 * covers live voice→text, zero infra) PLUS hold-to-record audio
 * (MediaRecorder → Supabase storage)". Two independent capture paths
 * in one composer:
 *   - Typed/dictated note: a plain textarea + "Save note" button,
 *     posts JSON to POST /api/site-captures (kind='note'). The hint
 *     line below it is the ENTIRE "dictation" implementation — iOS's
 *     own keyboard mic button writes directly into the textarea, no
 *     app code involved.
 *   - Hold-to-record voice note: press-and-hold the second button —
 *     starts a MediaRecorder on pointerdown, stops and uploads
 *     (multipart, kind='audio') on release. Recordings under
 *     MIN_RECORDING_MS are discarded (accidental taps), not uploaded.
 *     transcript_status starts 'pending' server-side — see
 *     app/api/site-captures/route.ts — Aria's Mac mini (local Whisper)
 *     fills in `transcript` later via MCP.
 */
export function NoteComposer({
  projectId,
  onCaptured,
}: {
  projectId: string;
  onCaptured: (capture: SiteCaptureWithUrl) => void;
}) {
  const [text, setText] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [uploadingAudio, setUploadingAudio] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startedAtRef = useRef(0);

  const audioMimeType = useMemo(() => pickAudioMimeType(), []);
  const audioSupported = audioMimeType !== null;

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  async function postNote() {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    setError(null);
    try {
      const res = await fetch("/api/site-captures", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_id: projectId, kind: "note", text_content: trimmed }),
      });
      if (!res.ok) {
        throw new Error((await res.json().catch(() => ({}))).error ?? "Could not save note.");
      }
      const body = await res.json();
      onCaptured(body.capture as SiteCaptureWithUrl);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save note.");
    } finally {
      setPosting(false);
    }
  }

  async function startRecording() {
    if (!audioMimeType) {
      setError("Voice recording isn't supported in this browser — the textarea's keyboard dictation still works.");
      return;
    }
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const recorder = new MediaRecorder(stream, { mimeType: audioMimeType });
      mimeTypeRef.current = audioMimeType;
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.start();
      mediaRecorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => {
        setRecordingSeconds(Math.round((Date.now() - startedAtRef.current) / 1000));
      }, 250);
    } catch {
      setError("Couldn't access the microphone — check browser/site permissions and try again.");
    }
  }

  function stopRecording() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    const stream = streamRef.current;
    if (!recorder) {
      setRecording(false);
      return;
    }
    const elapsedMs = Date.now() - startedAtRef.current;
    mediaRecorderRef.current = null;

    recorder.onstop = async () => {
      stream?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);

      if (elapsedMs < MIN_RECORDING_MS || chunksRef.current.length === 0) {
        // Accidental/too-short tap — discard silently, nothing uploaded.
        return;
      }

      const mimeType = mimeTypeRef.current ?? "audio/webm";
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";

      setUploadingAudio(true);
      setError(null);
      try {
        const form = new FormData();
        form.append("project_id", projectId);
        form.append("kind", "audio");
        form.append("file", new File([blob], `voice-note.${ext}`, { type: mimeType }));
        const res = await fetch("/api/site-captures", { method: "POST", body: form });
        if (!res.ok) {
          throw new Error((await res.json().catch(() => ({}))).error ?? "Upload failed.");
        }
        const body = await res.json();
        onCaptured(body.capture as SiteCaptureWithUrl);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed.");
      } finally {
        setUploadingAudio(false);
      }
    };

    if (recorder.state !== "inactive") recorder.stop();
  }

  return (
    <div>
      <p className="label-caps mb-2 text-sand">Note</p>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        placeholder="Type a note…"
        className="w-full border border-[#c9c2b4] bg-offwhite px-3 py-3 text-body text-nearblack focus:border-nearblack focus:outline-none"
      />
      <p className="mt-1 text-caption text-charcoal/50">Tap the mic on your keyboard to dictate.</p>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={postNote}
          disabled={posting || !text.trim()}
          className="bg-nearblack px-4 py-4 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-40"
        >
          {posting ? "Saving…" : "Save note"}
        </button>

        <button
          type="button"
          disabled={uploadingAudio || !audioSupported}
          onPointerDown={(e) => {
            e.preventDefault();
            void startRecording();
          }}
          onPointerUp={stopRecording}
          onPointerLeave={() => {
            if (recording) stopRecording();
          }}
          onPointerCancel={() => {
            if (recording) stopRecording();
          }}
          className={clsx(
            "touch-none select-none border px-4 py-4 text-subhead transition-colors disabled:opacity-40",
            recording
              ? "border-sand bg-sand/20 text-nearblack"
              : "border-nearblack text-nearblack hover:bg-nearblack hover:text-white"
          )}
        >
          {uploadingAudio ? "Uploading…" : recording ? `Recording… ${recordingSeconds}s` : "Hold to record"}
        </button>
      </div>

      {!audioSupported && (
        <p className="mt-2 text-caption text-charcoal/40">
          Voice recording isn&apos;t supported in this browser — dictation via the textarea above still works.
        </p>
      )}
      {error && <p className="mt-2 border border-red-700/40 bg-red-50 px-3 py-2 text-body text-red-700">{error}</p>}
    </div>
  );
}
