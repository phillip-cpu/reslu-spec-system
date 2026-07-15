"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import clsx from "clsx";
import { createClient } from "@/lib/supabase/client";
import { ASSET_BUCKET } from "@/lib/storage";
import {
  listPendingMeetingAudio,
  queueMeetingAudio,
  removePendingMeetingAudio,
  savePendingMeetingAudio,
  type PendingMeetingAudio,
} from "@/lib/offline-meeting-outbox";
import type { LeadMeetingListResponse, LeadMeetingRecordingWithUrl } from "@/types/lead-meetings";

const MAX_AUDIO_BYTES = 250 * 1024 * 1024;

function subscribeToConnectionStatus(callback: () => void) {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function connectionStatusSnapshot() {
  return navigator.onLine;
}

function supportedRecordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function formatMeetingDate(value: string | null, fallback: string): string {
  const date = new Date(value ?? fallback);
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function LeadMeetings({ leadId }: { leadId: string }) {
  const [recordings, setRecordings] = useState<LeadMeetingRecordingWithUrl[]>([]);
  const [queued, setQueued] = useState<PendingMeetingAudio[]>([]);
  const [loading, setLoading] = useState(true);
  const [flushing, setFlushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const online = useSyncExternalStore(subscribeToConnectionStatus, connectionStatusSnapshot, () => true);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flushingRef = useRef(false);
  const recordingMime = useMemo(() => supportedRecordingMime(), []);

  async function loadRecordings() {
    try {
      const response = await fetch(`/api/leads/${leadId}/meeting-recordings`, { cache: "no-store" });
      if (!response.ok) throw new Error((await response.json()).error ?? "Could not load meetings.");
      const body = (await response.json()) as LeadMeetingListResponse;
      setRecordings(body.recordings ?? []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load meetings.");
    } finally {
      setLoading(false);
    }
  }

  async function refreshQueue() {
    try {
      setQueued(await listPendingMeetingAudio(leadId));
    } catch {
      setQueued([]);
    }
  }

  async function flushOutbox() {
    if (flushingRef.current || (typeof navigator !== "undefined" && !navigator.onLine)) return;
    flushingRef.current = true;
    setFlushing(true);
    setError(null);
    try {
      const pending = await listPendingMeetingAudio(leadId);
      for (const item of pending) {
        let storagePath = item.storagePath;
        if (!storagePath) {
          const urlResponse = await fetch(`/api/leads/${leadId}/meeting-recordings/upload-url`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename: item.filename }),
          });
          const urlBody = await urlResponse.json();
          if (!urlResponse.ok) throw new Error(urlBody.error ?? "Could not start audio upload.");

          const supabase = createClient();
          const { error: uploadError } = await supabase.storage
            .from(ASSET_BUCKET)
            .uploadToSignedUrl(urlBody.path, urlBody.token, item.blob, {
              contentType: item.mimeType || "application/octet-stream",
            });
          if (uploadError) throw new Error(uploadError.message);
          storagePath = urlBody.path;
          await savePendingMeetingAudio({ ...item, storagePath });
        }

        const createResponse = await fetch(`/api/leads/${leadId}/meeting-recordings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            storage_path: storagePath,
            original_filename: item.filename,
            mime_type: item.mimeType,
            recorded_at: item.recordedAt,
            duration_seconds: item.durationSeconds,
          }),
        });
        const createBody = await createResponse.json();
        if (!createResponse.ok) throw new Error(createBody.error ?? "Could not save the meeting recording.");
        await removePendingMeetingAudio(item.id);
      }
      await Promise.all([refreshQueue(), loadRecordings()]);
      if (pending.length > 0) setNotice(`${pending.length} meeting recording${pending.length === 1 ? "" : "s"} uploaded for transcription.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Audio remains safely queued on this device.");
      await refreshQueue();
    } finally {
      flushingRef.current = false;
      setFlushing(false);
    }
  }

  useEffect(() => {
    const initialise = window.setTimeout(() => {
      void loadRecordings();
      void refreshQueue().then(() => flushOutbox());
    }, 0);
    const onOnline = () => void flushOutbox();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearTimeout(initialise);
      window.removeEventListener("online", onOnline);
      if (timerRef.current) clearInterval(timerRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
    // All functions are deliberately scoped to the current lead id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leadId]);

  async function queueFile(file: File, durationSeconds: number | null = null) {
    if (file.size <= 0) return;
    if (file.size > MAX_AUDIO_BYTES) {
      setError("This recording is larger than 250 MB. Export it in a compressed audio format and try again.");
      return;
    }
    setError(null);
    await queueMeetingAudio({
      leadId,
      filename: file.name || "meeting-audio",
      mimeType: file.type || "application/octet-stream",
      blob: file,
      recordedAt: new Date().toISOString(),
      durationSeconds,
    });
    await refreshQueue();
    if (navigator.onLine) await flushOutbox();
    else setNotice("Audio saved on this device and will upload when the connection returns.");
  }

  async function startRecording() {
    if (!recordingMime || !consentConfirmed) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: recordingMime });
      chunksRef.current = [];
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.start(1000);
      startedAtRef.current = Date.now();
      setRecording(true);
      setRecordingSeconds(0);
      timerRef.current = setInterval(() => setRecordingSeconds(Math.floor((Date.now() - startedAtRef.current) / 1000)), 500);
    } catch {
      setError("Could not access the microphone. Check Safari's microphone permission or upload a Voice Memos file instead.");
    }
  }

  function stopRecording() {
    const recorder = recorderRef.current;
    if (!recorder) return;
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = null;
    const durationSeconds = Math.max(1, Math.round((Date.now() - startedAtRef.current) / 1000));
    recorderRef.current = null;
    recorder.onstop = () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setRecording(false);
      const blob = new Blob(chunksRef.current, { type: recordingMime ?? "audio/webm" });
      const extension = (recordingMime ?? "").includes("mp4") ? "m4a" : "webm";
      void queueFile(new File([blob], `lead-meeting-${Date.now()}.${extension}`, { type: blob.type }), durationSeconds);
    };
    recorder.stop();
  }

  async function addSummaryToNotes(item: LeadMeetingRecordingWithUrl) {
    const text = [
      `Meeting — ${formatMeetingDate(item.recorded_at, item.created_at)}`,
      item.summary || item.transcript,
      item.decisions.length ? `Decisions:\n- ${item.decisions.join("\n- ")}` : null,
      item.action_items.length ? `Actions:\n- ${item.action_items.join("\n- ")}` : null,
    ].filter(Boolean).join("\n\n");
    const response = await fetch(`/api/leads/${leadId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      setError((await response.json()).error ?? "Could not add the meeting summary to notes.");
      return;
    }
    setNotice("Meeting summary added to lead notes.");
    window.dispatchEvent(new CustomEvent(`lead-notes-updated:${leadId}`));
  }

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps !text-charcoal/50">Meetings</p>
          <p className="mt-1 text-caption text-charcoal/50">Upload from Voice Memos for long meetings. Audio remains private and Aria transcribes it locally.</p>
        </div>
        <label className="cursor-pointer border border-nearblack px-3 py-2 text-caption text-nearblack hover:bg-nearblack hover:text-white">
          Upload audio
          <input
            type="file"
            accept="audio/*,.m4a,.mp3,.wav,.aac,.mp4,.webm"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void queueFile(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>

      <div className="mt-3 border border-[#dcd6cc] bg-nearwhite p-3">
        <label className="flex items-start gap-2 text-caption text-charcoal/65">
          <input type="checkbox" checked={consentConfirmed} onChange={(event) => setConsentConfirmed(event.target.checked)} className="mt-0.5 accent-nearblack" />
          <span>I have confirmed that everyone knows this meeting is being recorded.</span>
        </label>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={!recordingMime || (!recording && !consentConfirmed)}
            onClick={recording ? stopRecording : startRecording}
            className={clsx(
              "px-4 py-2 text-subhead disabled:opacity-40",
              recording ? "border border-red-700 bg-red-50 text-red-700" : "bg-nearblack text-white hover:bg-charcoal"
            )}
          >
            {recording ? `Stop recording · ${recordingSeconds}s` : "Record in browser"}
          </button>
          <span className="text-caption text-charcoal/45">Keep this screen active. Screen-lock recording is not guaranteed.</span>
        </div>
      </div>

      {queued.length > 0 && (
        <div className="mt-3 border border-sand bg-cream px-3 py-2 text-caption text-charcoal">
          {queued.length} recording{queued.length === 1 ? "" : "s"} saved on this device · {flushing ? "uploading…" : online ? "waiting to upload" : "offline"}
          {!flushing && online && <button type="button" onClick={flushOutbox} className="ml-2 underline">Retry now</button>}
        </div>
      )}
      {notice && <p className="mt-3 border border-sand bg-cream px-3 py-2 text-caption text-charcoal">{notice}</p>}
      {error && <p className="mt-3 border border-red-700/40 bg-red-50 px-3 py-2 text-caption text-red-700">{error}</p>}

      {loading ? (
        <p className="mt-3 text-caption text-charcoal/40">Loading meetings…</p>
      ) : recordings.length === 0 ? (
        <p className="mt-3 text-caption text-charcoal/40">No meeting recordings yet.</p>
      ) : (
        <div className="mt-3 space-y-3">
          {recordings.map((item) => (
            <article key={item.id} className="border border-[#dcd6cc] bg-offwhite p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-body text-nearblack">{formatMeetingDate(item.recorded_at, item.created_at)}</p>
                  <p className="text-caption text-charcoal/45">{item.original_filename}</p>
                </div>
                <span className="label-caps text-charcoal/55">
                  {item.transcript_status === "done" ? "Transcribed" : item.transcript_status === "failed" ? "Needs retry" : item.transcript_status === "processing" ? "Transcribing" : "Queued"}
                </span>
              </div>
              {item.audio_url && <audio controls preload="none" src={item.audio_url} className="mt-3 w-full" />}
              {item.failure_note && <p className="mt-2 text-caption text-red-700">{item.failure_note}</p>}
              {item.transcript_status === "done" && (
                <div className="mt-3 space-y-3 border-t border-[#dcd6cc] pt-3">
                  {item.summary && <p className="text-body text-charcoal">{item.summary}</p>}
                  {item.decisions.length > 0 && <div><p className="label-caps text-charcoal/50">Decisions</p><ul className="mt-1 list-disc space-y-1 pl-5 text-body text-charcoal">{item.decisions.map((value) => <li key={value}>{value}</li>)}</ul></div>}
                  {item.action_items.length > 0 && <div><p className="label-caps text-charcoal/50">Actions</p><ul className="mt-1 list-disc space-y-1 pl-5 text-body text-charcoal">{item.action_items.map((value) => <li key={value}>{value}</li>)}</ul></div>}
                  <details>
                    <summary className="cursor-pointer text-caption text-charcoal/55 underline">Full transcript</summary>
                    <p className="mt-2 whitespace-pre-wrap text-body text-charcoal/75">{item.transcript}</p>
                  </details>
                  <button type="button" onClick={() => addSummaryToNotes(item)} className="border border-nearblack px-3 py-2 text-caption text-nearblack hover:bg-nearblack hover:text-white">Add summary to lead notes</button>
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
