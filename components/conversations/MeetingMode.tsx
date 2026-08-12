"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import {
  listPendingConversationMeetingAudio,
  removePendingConversationMeetingAudio,
  savePendingConversationMeetingAudio,
  type PendingConversationMeetingAudio,
} from "@/lib/offline-meeting-outbox";
import { createClient } from "@/lib/supabase/client";
import { ASSET_BUCKET } from "@/lib/storage";
import { useDialogFocusBoundary } from "@/lib/use-dialog-focus-boundary";
import type {
  ConversationMeetingMinutes,
  MeetingContextResponse,
  MeetingDestinationCandidate,
  MeetingType,
} from "@/types/meeting-mode";

type ReviewFields = {
  summary: string;
  decisions: string;
  client_requests: string;
  reslu_actions: string;
  client_actions: string;
  open_questions: string;
  important_notes: string;
};

const EMPTY_REVIEW: ReviewFields = {
  summary: "",
  decisions: "",
  client_requests: "",
  reslu_actions: "",
  client_actions: "",
  open_questions: "",
  important_notes: "",
};

function recordingMime(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const type of ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"]) {
    if (typeof MediaRecorder.isTypeSupported !== "function" || MediaRecorder.isTypeSupported(type)) return type;
  }
  return null;
}

function secondsLabel(value: number) {
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function retentionDateLabel(value: string | null) {
  if (!value) return "Not scheduled";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(value));
}

function toLines(value: unknown): string {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").join("\n") : "";
}

function fromLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function reviewFromMeeting(meeting: ConversationMeetingMinutes): ReviewFields {
  return {
    summary: meeting.summary ?? "",
    decisions: toLines(meeting.decisions),
    client_requests: toLines(meeting.client_requests),
    reslu_actions: toLines(meeting.reslu_actions),
    client_actions: toLines(meeting.client_actions),
    open_questions: toLines(meeting.open_questions),
    important_notes: toLines(meeting.important_notes),
  };
}

function destinationValue(candidate: Pick<MeetingDestinationCandidate, "kind" | "id" | "client_event_id">) {
  const destination = `${candidate.kind}:${candidate.id}`;
  return candidate.client_event_id ? `${destination}:event:${candidate.client_event_id}` : destination;
}

export function MeetingMode({
  conversationId,
  initialMeetingId = null,
  sourceCallId = null,
  onClose,
  onFiled,
}: {
  conversationId: string;
  initialMeetingId?: string | null;
  sourceCallId?: string | null;
  onClose: () => void;
  onFiled: () => void;
}) {
  const [context, setContext] = useState<MeetingContextResponse | null>(null);
  const [meeting, setMeeting] = useState<ConversationMeetingMinutes | null>(null);
  const [selectedDestination, setSelectedDestination] = useState("");
  const [meetingType, setMeetingType] = useState<MeetingType>("client_meeting");
  const [consent, setConsent] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [review, setReview] = useState<ReviewFields>(EMPTY_REVIEW);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [audioSafeOnDevice, setAudioSafeOnDevice] = useState(false);
  const [recorderActive, setRecorderActive] = useState(false);
  const [allowDuplicate, setAllowDuplicate] = useState(false);
  const [canManageSource, setCanManageSource] = useState(false);
  const meetingRef = useRef<ConversationMeetingMinutes | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const pausedTotalRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const checkpointRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pendingAudioIdRef = useRef<string | null>(null);
  const clientSessionIdRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const mime = useMemo(() => recordingMime(), []);

  const setCurrentMeeting = useCallback((next: ConversationMeetingMinutes) => {
    meetingRef.current = next;
    setMeeting(next);
    if (next.status === "review") setReview(reviewFromMeeting(next));
    if (next.destination_kind && (next.lead_id || next.project_id)) {
      setSelectedDestination(destinationValue({
        kind: next.destination_kind,
        id: next.lead_id ?? next.project_id ?? "",
        client_event_id: next.client_event_id,
      }));
    }
    setMeetingType(next.meeting_type);
  }, []);

  const loadContext = useCallback(async () => {
    const response = await fetch(`/api/conversations/${conversationId}/meeting-mode/context`, { cache: "no-store" });
    const body = await response.json() as MeetingContextResponse & { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not prepare Meeting Mode");
    if (!mountedRef.current) return;
    setContext(body);
    setCanManageSource(Boolean(body.active_minutes && body.active_minutes.created_by === body.current_user_id));
    if (initialMeetingId) {
      const meetingResponse = await fetch(`/api/conversations/${conversationId}/meeting-mode/${initialMeetingId}`, { cache: "no-store" });
      const meetingBody = await meetingResponse.json() as { meeting?: ConversationMeetingMinutes; can_manage_source?: boolean; error?: string };
      if (!meetingResponse.ok || !meetingBody.meeting) throw new Error(meetingBody.error ?? "Could not load filed minutes");
      if (mountedRef.current) {
        setCanManageSource(meetingBody.can_manage_source === true);
        setCurrentMeeting(meetingBody.meeting);
      }
      return;
    }
    if (body.active_minutes) {
      setCurrentMeeting(body.active_minutes);
      setCanManageSource(body.active_minutes.created_by === body.current_user_id);
      return;
    }
    if (body.suggested) {
      setSelectedDestination(destinationValue(body.suggested));
      setMeetingType(body.suggested.meeting_type);
    }
  }, [conversationId, initialMeetingId, setCurrentMeeting]);

  useEffect(() => {
    mountedRef.current = true;
    const initialise = window.setTimeout(() => {
      void loadContext().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not prepare Meeting Mode"));
    }, 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialise);
      if (timerRef.current) clearInterval(timerRef.current);
      if (checkpointRef.current) clearInterval(checkpointRef.current);
      streamRef.current?.getTracks().forEach((track) => track.stop());
    };
  }, [loadContext]);

  useEffect(() => {
    if (!meeting || !["processing", "review", "failed"].includes(meeting.status)) return;
    if (meeting.status === "review") return;
    const poll = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/meeting-mode/${meeting.id}`, { cache: "no-store" });
        const body = await response.json() as { meeting?: ConversationMeetingMinutes };
        if (response.ok && body.meeting && mountedRef.current) setCurrentMeeting(body.meeting);
      } catch { /* the durable task keeps running; retry on the next poll */ }
    }, 3000);
    return () => window.clearInterval(poll);
  }, [conversationId, meeting, setCurrentMeeting]);

  useEffect(() => {
    if (!meeting || !["recording", "paused"].includes(meeting.status) || recorderRef.current) return;
    void listPendingConversationMeetingAudio(meeting.id)
      .then((pending) => {
        if (!mountedRef.current) return;
        pendingAudioIdRef.current = pending[0]?.id ?? null;
        setAudioSafeOnDevice(pending.length > 0);
      })
      .catch(() => null);
  }, [meeting]);

  const selectedCandidate = useMemo(() => context?.candidates.find((candidate) => destinationValue(candidate) === selectedDestination) ?? null, [context, selectedDestination]);

  async function patchMeeting(action: string, values: Record<string, unknown> = {}) {
    const currentMeeting = meetingRef.current;
    if (!currentMeeting) throw new Error("Meeting has not started");
    const response = await fetch(`/api/conversations/${conversationId}/meeting-mode/${currentMeeting.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, ...values }),
    });
    const body = await response.json() as { meeting?: ConversationMeetingMinutes; error?: string };
    if (!response.ok || !body.meeting) throw new Error(body.error ?? "Meeting update failed");
    setCurrentMeeting(body.meeting);
    return body.meeting;
  }

  function activeSeconds() {
    if (!startedAtRef.current) return meeting?.duration_seconds ?? 0;
    const now = pausedAtRef.current || Date.now();
    return Math.max(0, Math.floor((now - startedAtRef.current - pausedTotalRef.current) / 1000));
  }

  async function checkpointLocalAudio() {
    const currentMeeting = meetingRef.current;
    const pendingId = pendingAudioIdRef.current;
    if (!currentMeeting || !pendingId || chunksRef.current.length === 0) return;
    const blob = new Blob(chunksRef.current, { type: mime ?? "audio/webm" });
    if (blob.size <= 0) return;
    const extension = (mime ?? "").includes("mp4") ? "m4a" : "webm";
    await savePendingConversationMeetingAudio({
      id: pendingId,
      meetingId: currentMeeting.id,
      conversationId,
      filename: `meeting-${currentMeeting.id}.${extension}`,
      mimeType: blob.type || mime || "application/octet-stream",
      blob,
      durationSeconds: Math.max(1, activeSeconds()),
      createdAt: currentMeeting.started_at,
    });
    if (mountedRef.current) setAudioSafeOnDevice(true);
  }

  function startTimers() {
    if (timerRef.current) clearInterval(timerRef.current);
    if (checkpointRef.current) clearInterval(checkpointRef.current);
    timerRef.current = setInterval(() => setSeconds(activeSeconds()), 500);
    checkpointRef.current = setInterval(() => {
      if (!meetingRef.current?.id) return;
      void patchMeeting("checkpoint", { duration_seconds: activeSeconds() }).catch(() => null);
      void checkpointLocalAudio().catch(() => null);
    }, 30_000);
  }

  async function startCapture() {
    if (!consent || !mime || busy) return;
    setBusy(true);
    setError(null);
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const destination = selectedCandidate;
      const clientSessionId = clientSessionIdRef.current ?? crypto.randomUUID();
      clientSessionIdRef.current = clientSessionId;
      const response = await fetch(`/api/conversations/${conversationId}/meeting-mode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_session_id: clientSessionId,
          consent_confirmed: true,
          source_call_id: sourceCallId,
          destination_kind: destination?.kind ?? null,
          destination_id: destination?.id ?? null,
          client_event_id: destination?.client_event_id ?? null,
          meeting_type: destination?.meeting_type ?? meetingType,
        }),
      });
      const body = await response.json() as { meeting?: ConversationMeetingMinutes; error?: string };
      if (!response.ok || !body.meeting) throw new Error(body.error ?? "Could not start Meeting Mode");
      setCurrentMeeting(body.meeting);
      setCanManageSource(true);
      if (response.status !== 201) {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        setNotice("An unfinished Meeting Mode session already exists in this conversation.");
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      chunksRef.current = [];
      pendingAudioIdRef.current = crypto.randomUUID();
      streamRef.current = stream;
      recorderRef.current = recorder;
      setRecorderActive(true);
      recorder.ondataavailable = (event) => { if (event.data.size > 0) chunksRef.current.push(event.data); };
      recorder.start(1000);
      startedAtRef.current = Date.now();
      pausedAtRef.current = 0;
      pausedTotalRef.current = 0;
      setSeconds(0);
      startTimers();
    } catch (reason) {
      stream?.getTracks().forEach((track) => track.stop());
      setError(reason instanceof Error ? reason.message : "Could not access the microphone");
    } finally {
      setBusy(false);
    }
  }

  async function pauseCapture() {
    if (!meeting || !recorderRef.current) return;
    setBusy(true);
    setError(null);
    try {
      recorderRef.current.pause();
      pausedAtRef.current = Date.now();
      await checkpointLocalAudio();
      await patchMeeting("pause");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not pause minutes");
    } finally { setBusy(false); }
  }

  async function resumeCapture() {
    if (!meeting || !recorderRef.current) return;
    setBusy(true);
    setError(null);
    try {
      if (pausedAtRef.current) pausedTotalRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = 0;
      recorderRef.current.resume();
      await patchMeeting("resume");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not resume minutes");
    } finally { setBusy(false); }
  }

  function stopRecorder(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      const recorder = recorderRef.current;
      if (!recorder) return reject(new Error("The meeting recorder is not active"));
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime ?? "audio/webm" });
        recorderRef.current = null;
        setRecorderActive(false);
        streamRef.current?.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        resolve(blob);
      };
      recorder.onerror = () => reject(new Error("The browser could not finish the recording"));
      recorder.stop();
    });
  }

  async function uploadPendingAudio(entry: PendingConversationMeetingAudio) {
    if (!meeting) throw new Error("Meeting has not started");
    const urlResponse = await fetch(`/api/conversations/${conversationId}/meeting-mode/${meeting.id}/upload-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: entry.filename, byte_size: entry.blob.size }),
    });
    const urlBody = await urlResponse.json() as { path?: string; token?: string; error?: string };
    if (!urlResponse.ok || !urlBody.path || !urlBody.token) throw new Error(urlBody.error ?? "Could not start the private upload");
    const withPath = { ...entry, storagePath: urlBody.path };
    await savePendingConversationMeetingAudio(withPath);
    const supabase = createClient();
    const { error: uploadError } = await supabase.storage.from(ASSET_BUCKET).uploadToSignedUrl(
      urlBody.path,
      urlBody.token,
      entry.blob,
      { contentType: entry.mimeType || "application/octet-stream" },
    );
    if (uploadError) throw new Error(uploadError.message);
    const finished = await patchMeeting("finish", {
      recording_storage_path: urlBody.path,
      recording_filename: entry.filename,
      recording_mime_type: entry.mimeType,
      recording_byte_size: entry.blob.size,
      duration_seconds: entry.durationSeconds,
    });
    await removePendingConversationMeetingAudio(entry.id);
    setAudioSafeOnDevice(false);
    setNotice("Recording uploaded privately. Aria is preparing the draft in the background.");
    return finished;
  }

  async function finishCapture() {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    setNotice("Finishing and securing the recording…");
    if (timerRef.current) clearInterval(timerRef.current);
    if (checkpointRef.current) clearInterval(checkpointRef.current);
    try {
      const durationSeconds = Math.max(1, activeSeconds());
      setSeconds(durationSeconds);
      const blob = await stopRecorder();
      if (blob.size <= 0) throw new Error("The recording was empty");
      const extension = (mime ?? "").includes("mp4") ? "m4a" : "webm";
      const entry: PendingConversationMeetingAudio = {
        id: pendingAudioIdRef.current ?? crypto.randomUUID(),
        meetingId: meeting.id,
        conversationId,
        filename: `meeting-${Date.now()}.${extension}`,
        mimeType: blob.type || mime || "application/octet-stream",
        blob,
        durationSeconds,
        createdAt: new Date().toISOString(),
      };
      await savePendingConversationMeetingAudio(entry);
      setAudioSafeOnDevice(true);
      await uploadPendingAudio(entry);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The recording remains safe on this device. Retry the upload when online.");
      setNotice("The recording remains safe on this device. It has not been filed.");
      try { await patchMeeting("pause"); } catch { /* the local copy remains authoritative for retry */ }
    } finally { setBusy(false); }
  }

  async function retryUpload() {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    try {
      const pending = await listPendingConversationMeetingAudio(meeting.id);
      if (!pending.length) throw new Error("No local recording was found on this device");
      setAudioSafeOnDevice(true);
      await uploadPendingAudio(pending[0]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload retry failed");
    } finally { setBusy(false); }
  }

  async function retryDraft() {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    try {
      await patchMeeting("retry_processing");
      setNotice("Aria is trying the private recording again.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not retry draft preparation");
    } finally { setBusy(false); }
  }

  async function saveReview() {
    if (!meeting) throw new Error("Draft is not available");
    const destination = context?.candidates.find((candidate) => destinationValue(candidate) === selectedDestination) ?? null;
    return patchMeeting("save_draft", {
      expected_version: meeting.draft_version,
      meeting_type: meetingType,
      destination_kind: destination?.kind ?? null,
      destination_id: destination?.id ?? null,
      client_event_id: destination?.client_event_id ?? null,
      summary: review.summary,
      decisions: fromLines(review.decisions),
      client_requests: fromLines(review.client_requests),
      reslu_actions: fromLines(review.reslu_actions),
      client_actions: fromLines(review.client_actions),
      open_questions: fromLines(review.open_questions),
      important_notes: fromLines(review.important_notes),
    });
  }

  async function approveAndFile() {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveReview();
      await patchMeeting("file", { expected_version: saved.draft_version, allow_duplicate: allowDuplicate });
      onFiled();
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Minutes were not filed");
    } finally { setBusy(false); }
  }

  async function discard() {
    if (!meeting || busy || !window.confirm("Discard this staged meeting draft? The private source recording remains governed by RESLU retention policy.")) return;
    setBusy(true);
    try {
      await patchMeeting("discard");
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not discard the draft");
    } finally { setBusy(false); }
  }

  async function discardInterruptedCapture() {
    if (!meeting || busy) return;
    setBusy(true);
    setError(null);
    try {
      await patchMeeting("discard");
      meetingRef.current = null;
      setMeeting(null);
      setAudioSafeOnDevice(false);
      setNotice("Interrupted capture discarded. You can start a fresh meeting.");
      await loadContext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not discard the interrupted capture");
    } finally { setBusy(false); }
  }

  async function deleteMeetingSource(kind: "recording" | "transcript") {
    if (!meeting || busy || !canManageSource) return;
    const label = kind === "recording" ? "raw meeting audio" : "source transcript";
    if (!window.confirm(`Permanently delete the ${label}? Filed structured minutes will remain, but this source cannot be recovered.`)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/meeting-mode/${meeting.id}/source`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [kind]: true }),
      });
      const body = await response.json() as { meeting?: ConversationMeetingMinutes; error?: string };
      if (!response.ok || !body.meeting) throw new Error(body.error ?? `Could not delete the ${label}`);
      setCurrentMeeting(body.meeting);
      setNotice(`${kind === "recording" ? "Raw meeting audio" : "Source transcript"} permanently deleted. Filed structured minutes were preserved.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : `Could not delete the ${label}`);
    } finally {
      setBusy(false);
    }
  }

  const status = meeting?.status ?? "setup";
  const setup = !meeting;
  const recording = status === "recording";
  const paused = status === "paused";
  const processing = status === "processing";
  const reviewReady = status === "review";
  const failed = status === "failed";
  const filed = status === "filed";
  const queuedForUpload = (paused || recording) && audioSafeOnDevice && !recorderActive;
  const interruptedCapture = (paused || recording) && !audioSafeOnDevice && !recorderActive;
  const recordingAvailable = Boolean(meeting?.recording_storage_path && !meeting.recording_deleted_at);
  const transcriptAvailable = Boolean(meeting?.transcript && !meeting.transcript_deleted_at);
  const sourcePrivacyPanel = meeting && (
    <section className="mt-6 rounded-xl border border-[#d4cbbd] bg-[#faf7f0] p-4 md:p-5" aria-labelledby="meeting-source-privacy-title">
      <h3 id="meeting-source-privacy-title" className="text-subhead font-semibold">Source privacy</h3>
      <p className="mt-2 text-caption leading-relaxed text-charcoal/60">
        Filed structured minutes remain the business record. The proposed deletion dates are {retentionDateLabel(meeting.recording_retain_until)} for raw audio and {retentionDateLabel(meeting.transcript_retain_until)} for the source transcript. Automatic purging remains off until RESLU approves the policy; the recorder can delete either source now.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {transcriptAvailable && <a href={`/api/conversations/${conversationId}/meeting-mode/${meeting.id}/source?kind=transcript`} target="_blank" rel="noreferrer" className="min-h-11 rounded-xl border border-nearblack px-4 py-3 text-caption font-semibold">Export transcript</a>}
        {transcriptAvailable && <a href={`/api/conversations/${conversationId}/meeting-mode/${meeting.id}/source?kind=bundle`} target="_blank" rel="noreferrer" className="min-h-11 rounded-xl border border-nearblack px-4 py-3 text-caption font-semibold">Export minutes + transcript</a>}
        {canManageSource && recordingAvailable && <a href={`/api/conversations/${conversationId}/meeting-mode/${meeting.id}/source?kind=recording`} target="_blank" rel="noreferrer" className="min-h-11 rounded-xl border border-nearblack px-4 py-3 text-caption font-semibold">Export raw audio</a>}
        {canManageSource && recordingAvailable && <button type="button" disabled={busy} onClick={() => void deleteMeetingSource("recording")} className="min-h-11 rounded-xl px-4 py-3 text-caption font-semibold text-red-800 disabled:opacity-35">Delete raw audio</button>}
        {canManageSource && transcriptAvailable && <button type="button" disabled={busy} onClick={() => void deleteMeetingSource("transcript")} className="min-h-11 rounded-xl px-4 py-3 text-caption font-semibold text-red-800 disabled:opacity-35">Delete transcript</button>}
      </div>
      {!recordingAvailable && meeting.recording_deleted_at && <p className="mt-3 text-caption text-charcoal/55">Raw audio deleted {retentionDateLabel(meeting.recording_deleted_at)}.</p>}
      {!transcriptAvailable && meeting.transcript_deleted_at && <p className="mt-2 text-caption text-charcoal/55">Source transcript deleted {retentionDateLabel(meeting.transcript_deleted_at)}.</p>}
    </section>
  );

  useDialogFocusBoundary({
    active: true,
    containerRef: dialogRef,
    onEscape: onClose,
    escapeDisabled: recording || paused || busy,
  });

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="meeting-mode-title"
      tabIndex={-1}
      className="meeting-mode-dialog fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-[75] flex h-[var(--conversation-vh,100dvh)] min-h-0 flex-col bg-[#f5f1e8] text-nearblack"
    >
      <header className="flex shrink-0 items-center gap-3 border-b border-[#d4cbbd] px-4 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-6 md:py-4">
        <span className={clsx("h-3 w-3 rounded-full", recording ? "animate-pulse bg-red-700" : processing ? "bg-[#C9971E]" : "bg-[#66a466]")} />
        <div className="min-w-0 flex-1">
          <h1 id="meeting-mode-title" className="text-[11px] font-bold uppercase tracking-[0.14em] text-[#806d55]">Aria Meeting Mode</h1>
          <p className="mt-1 truncate text-caption text-charcoal/55" role="status" aria-live="polite" aria-atomic="true">
            {setup ? "Resolve context and confirm consent" : recording ? `Recording · ${secondsLabel(seconds)}` : paused ? `Paused · ${secondsLabel(seconds)}` : processing ? "Preparing draft minutes in background" : reviewReady ? "Review before filing" : failed ? "Draft preparation needs attention" : status}
          </p>
        </div>
        <button type="button" onClick={onClose} disabled={recording || paused || busy} className="min-h-11 rounded-full border border-nearblack/30 px-4 py-2 text-caption disabled:opacity-30">Close</button>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-8">
        <div className="mx-auto max-w-4xl">
          {error && <p className="mb-4 rounded-xl border border-red-700/30 bg-red-50 px-4 py-3 text-body text-red-800" role="alert">{error}</p>}
          {notice && <p className="mb-4 rounded-xl border border-sand bg-cream px-4 py-3 text-body text-charcoal" role="status" aria-live="polite">{notice}</p>}

          {setup && (
            <section className="rounded-2xl border border-[#d4cbbd] bg-white p-5 shadow-sm md:p-7">
              <h2 className="font-display text-section">Take client meeting minutes</h2>
              <p className="mt-2 text-body leading-relaxed text-charcoal/65">Aria records silently, prepares a private draft, and waits for you to approve the correct lead or project file.</p>
              {!context ? <p className="mt-6 text-body text-charcoal/50">Resolving calendar and RESLU context…</p> : (
                <>
                  <label className="mt-6 block">
                    <span className="label-caps text-charcoal/55">Destination</span>
                    <select
                      value={selectedDestination}
                      onChange={(event) => {
                        setSelectedDestination(event.target.value);
                        setAllowDuplicate(false);
                        const candidate = context.candidates.find((item) => destinationValue(item) === event.target.value);
                        if (candidate) setMeetingType(candidate.meeting_type);
                      }}
                      className="mt-2 w-full rounded-xl border border-[#cfc6b8] bg-white px-4 py-3 text-[16px] outline-none focus:border-nearblack"
                    >
                      <option value="">Unassigned draft — choose after the meeting</option>
                      {context.candidates.map((candidate) => (
                        <option key={destinationValue(candidate)} value={destinationValue(candidate)}>{candidate.label}{candidate.subtitle ? ` — ${candidate.subtitle}` : ""}{candidate.duplicate_filed_minutes_id ? " — minutes already filed" : ""}</option>
                      ))}
                    </select>
                  </label>
                  {context.needs_clarification && <p className="mt-2 text-caption text-charcoal/55">{context.clarification} You can leave it unassigned and decide during review.</p>}
                  {selectedCandidate && (
                    <div className="mt-3 rounded-xl bg-[#f4efe6] p-3 text-caption text-charcoal/65">
                      <p className="font-semibold text-nearblack">Proposed: {selectedCandidate.label}</p>
                      <p className="mt-1">{selectedCandidate.reasons.join(" · ")}</p>
                    </div>
                  )}
                  <label className="mt-6 flex items-start gap-3 rounded-xl border border-[#d4cbbd] bg-[#faf7f0] p-4 text-body text-charcoal/75">
                    <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4 accent-nearblack" />
                    <span>I have told everyone that Aria will record this meeting and they have consented.</span>
                  </label>
                  <p className="mt-3 text-caption text-charcoal/50">Audio uploads to private RESLU storage and is transcribed locally on the Mac mini. It is not sent to OpenAI. The proposed policy keeps raw audio for 30 days and the source transcript for 365 days; you can explicitly export or delete either source.</p>
                  <button type="button" onClick={() => void startCapture()} disabled={!consent || !mime || busy} className="mt-6 w-full rounded-xl bg-nearblack px-5 py-4 text-subhead text-white disabled:opacity-35">
                    {busy ? "Starting…" : mime ? "Start taking minutes" : "Recording is not supported in this browser"}
                  </button>
                </>
              )}
            </section>
          )}

          {(recording || (paused && !queuedForUpload)) && !interruptedCapture && (
            <section className="flex min-h-[60vh] flex-col items-center justify-center text-center">
              <div className={clsx("flex h-28 w-28 items-center justify-center rounded-full border-4", recording ? "animate-pulse border-red-700 bg-red-50" : "border-sand bg-cream")}>
                <span className={clsx("h-8 w-8 rounded-full", recording ? "bg-red-700" : "bg-sand")} />
              </div>
              <h2 className="mt-6 font-display text-[34px]">{recording ? "Aria is taking minutes" : "Minutes paused"}</h2>
              <p className="mt-3 text-[24px] tabular-nums text-charcoal/65">{secondsLabel(seconds)}</p>
              <p className="mt-4 max-w-xl text-body leading-relaxed text-charcoal/55">Aria stays silent. The recording is not filed anywhere until the structured draft is reviewed and approved.</p>
              <div className="mt-8 flex w-full max-w-xl gap-3">
                <button type="button" onClick={() => void (recording ? pauseCapture() : resumeCapture())} disabled={busy} className="flex-1 rounded-xl border border-nearblack px-4 py-4 text-subhead disabled:opacity-35">{recording ? "Pause minutes" : "Resume minutes"}</button>
                <button type="button" onClick={() => void finishCapture()} disabled={busy} className="flex-1 rounded-xl bg-nearblack px-4 py-4 text-subhead text-white disabled:opacity-35">{busy ? "Securing…" : "Finish meeting"}</button>
              </div>
            </section>
          )}

          {interruptedCapture && (
            <section className="flex min-h-[55vh] flex-col items-center justify-center text-center">
              <h2 className="font-display text-[32px]">Capture was interrupted</h2>
              <p className="mt-3 max-w-xl text-body leading-relaxed text-charcoal/60">No recoverable recording was found on this device, and nothing was filed. Discard this empty session before starting again.</p>
              <button type="button" onClick={() => void discardInterruptedCapture()} disabled={busy} className="mt-6 rounded-xl bg-nearblack px-5 py-3 text-subhead text-white disabled:opacity-35">{busy ? "Discarding…" : "Discard interrupted capture"}</button>
            </section>
          )}

          {queuedForUpload && (
            <section className="flex min-h-[55vh] flex-col items-center justify-center text-center">
              <div className="flex h-24 w-24 items-center justify-center rounded-full border-4 border-sand bg-cream text-3xl">✓</div>
              <h2 className="mt-6 font-display text-[32px]">Recording safe on this device</h2>
              <p className="mt-3 max-w-xl text-body leading-relaxed text-charcoal/60">The private upload did not finish, so Aria has not started drafting and nothing has been filed. Retry when the connection is stable.</p>
              <div className="mt-6 flex gap-3">
                <button type="button" onClick={() => void retryUpload()} disabled={busy} className="rounded-xl bg-nearblack px-5 py-3 text-subhead text-white disabled:opacity-35">{busy ? "Uploading…" : "Retry upload"}</button>
                <button type="button" onClick={onClose} className="rounded-xl border border-nearblack px-5 py-3 text-subhead">Return to chat</button>
              </div>
            </section>
          )}

          {processing && (
            <section className="flex min-h-[55vh] flex-col items-center justify-center text-center">
              <div className="h-14 w-14 animate-spin rounded-full border-4 border-[#d4cbbd] border-t-nearblack" />
              <h2 className="mt-6 font-display text-[32px]">Preparing draft minutes</h2>
              <p className="mt-3 max-w-xl text-body leading-relaxed text-charcoal/60">The recording is private and Aria’s durable task is running. You can close this screen; the task continues.</p>
              <button type="button" onClick={onClose} className="mt-6 rounded-xl border border-nearblack px-5 py-3 text-subhead">Return to chat</button>
            </section>
          )}

          {failed && (
            <section className="rounded-2xl border border-red-700/30 bg-white p-6 text-center">
              <h2 className="font-display text-section">Minutes need attention</h2>
              <p className="mt-3 text-body text-red-800">{meeting?.failure_note ?? "Aria could not prepare this draft."}</p>
              {audioSafeOnDevice && <p className="mt-3 text-body text-charcoal/60">The recording is still safe on this device.</p>}
              <div className="mt-6 flex justify-center gap-3">
                <button type="button" onClick={() => void (audioSafeOnDevice ? retryUpload() : retryDraft())} disabled={busy} className="rounded-xl bg-nearblack px-5 py-3 text-subhead text-white disabled:opacity-35">{audioSafeOnDevice ? "Retry upload" : "Retry draft"}</button>
                <button type="button" onClick={onClose} className="rounded-xl border border-nearblack px-5 py-3 text-subhead">Close</button>
              </div>
            </section>
          )}

          {reviewReady && meeting && (
            <section>
              <div className="rounded-2xl border border-[#d4cbbd] bg-white p-5 md:p-7">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="label-caps text-charcoal/50">Draft minutes</p>
                    <h2 className="mt-2 font-display text-section">Review what Aria captured</h2>
                  </div>
                  <span className="rounded-full bg-[#edf4ea] px-3 py-1.5 text-caption font-semibold text-[#35613a]">Not filed</span>
                </div>
                <label className="mt-6 block">
                  <span className="label-caps text-charcoal/55">File to</span>
                  <select value={selectedDestination} onChange={(event) => { setSelectedDestination(event.target.value); setAllowDuplicate(false); }} className="mt-2 w-full rounded-xl border border-[#cfc6b8] bg-white px-4 py-3 text-[16px] outline-none focus:border-nearblack">
                    <option value="">Choose a lead or project before filing</option>
                    {context?.candidates.map((candidate) => <option key={destinationValue(candidate)} value={destinationValue(candidate)}>{candidate.label}{candidate.subtitle ? ` — ${candidate.subtitle}` : ""}{candidate.duplicate_filed_minutes_id ? " — minutes already filed" : ""}</option>)}
                  </select>
                </label>
                {selectedCandidate?.duplicate_filed_minutes_id && (
                  <label className="mt-3 flex items-start gap-3 rounded-xl border border-[#d8b36a] bg-[#fff8e8] p-4 text-body text-charcoal/75">
                    <input type="checkbox" checked={allowDuplicate} onChange={(event) => setAllowDuplicate(event.target.checked)} className="mt-1 h-4 w-4 accent-nearblack" />
                    <span>Minutes are already filed for this calendar event. I have checked them and want to file another record.</span>
                  </label>
                )}
                <label className="mt-5 block">
                  <span className="label-caps text-charcoal/55">Meeting summary</span>
                  <textarea value={review.summary} onChange={(event) => setReview((current) => ({ ...current, summary: event.target.value }))} rows={5} className="mt-2 w-full rounded-xl border border-[#cfc6b8] bg-white px-4 py-3 text-[17px] leading-relaxed outline-none focus:border-nearblack" />
                </label>
                <div className="mt-5 grid gap-5 md:grid-cols-2">
                  {([
                    ["decisions", "Decisions"],
                    ["client_requests", "Client requests"],
                    ["reslu_actions", "RESLU actions"],
                    ["client_actions", "Client actions"],
                    ["open_questions", "Open questions"],
                    ["important_notes", "Important notes"],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="label-caps text-charcoal/55">{label}</span>
                      <textarea value={review[key]} onChange={(event) => setReview((current) => ({ ...current, [key]: event.target.value }))} rows={4} placeholder="One item per line" className="mt-2 w-full rounded-xl border border-[#cfc6b8] bg-white px-4 py-3 text-[16px] leading-relaxed outline-none focus:border-nearblack" />
                    </label>
                  ))}
                </div>
                {transcriptAvailable && <details className="mt-6 rounded-xl border border-[#d4cbbd] bg-[#faf7f0] p-4">
                  <summary className="cursor-pointer text-caption font-semibold text-charcoal/65">Source transcript</summary>
                  <p className="mt-3 max-h-80 overflow-y-auto whitespace-pre-wrap text-caption leading-relaxed text-charcoal/60">{meeting.transcript}</p>
                </details>}
                {sourcePrivacyPanel}
              </div>
              <div className="sticky bottom-0 mt-4 flex flex-wrap gap-3 border-t border-[#d4cbbd] bg-[#f5f1e8]/95 py-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] backdrop-blur">
                <button type="button" onClick={() => void approveAndFile()} disabled={busy || !selectedDestination || !review.summary.trim() || Boolean(selectedCandidate?.duplicate_filed_minutes_id && !allowDuplicate)} className="min-w-56 flex-1 rounded-xl bg-nearblack px-5 py-4 text-subhead text-white disabled:opacity-35">{busy ? "Filing…" : "Approve & file"}</button>
                <button type="button" onClick={() => void saveReview().catch((reason) => setError(reason instanceof Error ? reason.message : "Could not save draft"))} disabled={busy || !review.summary.trim()} className="rounded-xl border border-nearblack px-5 py-4 text-subhead disabled:opacity-35">Save draft</button>
                <button type="button" onClick={() => void discard()} disabled={busy} className="rounded-xl px-5 py-4 text-subhead text-red-800 disabled:opacity-35">Discard</button>
              </div>
            </section>
          )}

          {filed && meeting && (
            <section className="rounded-2xl border border-[#d4cbbd] bg-white p-5 md:p-8">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="label-caps text-charcoal/50">Filed meeting record</p>
                  <h2 className="mt-2 font-display text-section">{meeting.destination_label_snapshot ?? "Meeting minutes"}</h2>
                </div>
                <span className="rounded-full bg-[#edf4ea] px-3 py-1.5 text-caption font-semibold text-[#35613a]">Filed</span>
              </div>
              <p className="mt-6 whitespace-pre-wrap text-[18px] leading-relaxed text-charcoal/80">{meeting.summary}</p>
              <div className="mt-6 grid gap-5 md:grid-cols-2">
                {([
                  ["decisions", "Decisions"],
                  ["client_requests", "Client requests"],
                  ["reslu_actions", "RESLU actions"],
                  ["client_actions", "Client actions"],
                  ["open_questions", "Open questions"],
                  ["important_notes", "Important notes"],
                ] as const).map(([key, label]) => meeting[key].length > 0 && (
                  <div key={key}>
                    <p className="label-caps text-charcoal/50">{label}</p>
                    <ul className="mt-2 list-disc space-y-2 pl-5 text-body leading-relaxed text-charcoal/75">{meeting[key].map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                ))}
              </div>
              {transcriptAvailable && <details className="mt-6 rounded-xl border border-[#d4cbbd] bg-[#faf7f0] p-4">
                <summary className="cursor-pointer text-caption font-semibold text-charcoal/65">Source transcript</summary>
                <p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-caption leading-relaxed text-charcoal/60">{meeting.transcript}</p>
              </details>}
              {sourcePrivacyPanel}
            </section>
          )}
        </div>
      </main>
    </div>
  );
}
