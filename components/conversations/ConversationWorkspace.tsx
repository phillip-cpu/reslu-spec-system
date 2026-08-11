"use client";

import { Fragment, FormEvent, PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { MeetingMode } from "@/components/conversations/MeetingMode";
import Image from "next/image";
import { initials } from "@/lib/conversations";
import {
  agentTaskArtifactText,
  normalizeAgentTaskArtifactContent,
} from "@/lib/agent-task-artifact";
import {
  CONVERSATION_DIRECT_UPLOAD_MAX_BYTES,
  conversationAttachmentKind,
  isConversationAttachmentMime,
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
} from "@/lib/conversation-attachments";
import {
  awaitConversationUploadReady,
  isRecoverableConversationUploadError,
  type ConversationUploadProbe,
} from "@/lib/conversation-upload-recovery";
import { prepareConversationImageForUpload } from "@/lib/conversation-image-upload";
import { isFatalSpeechRecognitionError, speechRecognitionErrorMessage } from "@/lib/conversation-voice";
import {
  listPendingConversationCallEnds,
  removePendingConversationCallEnd,
  savePendingConversationCallEnd,
  type PendingConversationCallEnd,
} from "@/lib/conversation-call-outbox";
import type { RealtimeVoiceLatencyMetric, RealtimeVoiceOutcome } from "@/lib/realtime-voice-metrics";
import {
  nativeVoiceBridgeAvailable,
  postNativeVoiceBridgeEvent,
  prepareNativeVoiceSession,
} from "@/lib/native-voice-bridge";
import {
  parseRealtimeConsultArguments,
  parseRealtimeTaskArguments,
} from "@/lib/realtime-tool-arguments";
import {
  MAX_REALTIME_RECONNECT_ATTEMPTS,
  mediaStreamCanResume,
  realtimeReconnectDelay,
  shouldAttemptRealtimeReconnect,
} from "@/lib/realtime-call-recovery";
import { buildRealtimeProgressResponse, realtimeProgressCueId } from "@/lib/realtime-progress";
import {
  CONVERSATION_MESSAGE_REACTIONS,
  type ConversationMessageReactionValue,
} from "@/lib/conversation-message-engagement";
import {
  CONVERSATION_MESSAGE_LONG_PRESS_MS,
  conversationDayKey,
  conversationDayLabel,
  conversationLongPressMoved,
} from "@/lib/conversation-timeline";
import {
  listConversationDrafts,
  listPendingConversationMessages,
  mergePendingConversationMessages,
  recoverPendingConversationMessage,
  removeConversationDraft,
  removePendingConversationMessage,
  saveConversationDraft,
  savePendingConversationMessage,
  type PendingConversationMessage,
} from "@/lib/conversation-outbox";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import {
  isConversationVoiceNoteDuration,
  isConversationVoiceNoteMime,
  isVoiceNoteMetadata,
  MAX_CONVERSATION_VOICE_NOTE_DURATION_MS,
  voiceNoteDurationLabel,
  voiceNoteExtension,
} from "@/lib/conversation-voice-note";
import type {
  AgentSlug,
  AgentTask,
  ConversationAgentActivity,
  ConversationAttachment,
  ConversationMessage,
  ConversationParticipant,
  ConversationSummary,
  ConversationsResponse,
} from "@/types/conversations";

type CallState = "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "reconnecting";
const MESSAGE_SEND_TIMEOUT_MS = 20000;
const ATTACHMENT_FINALIZE_REQUEST_TIMEOUT_MS = 6000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SpeechResultLike {
  isFinal: boolean;
  0: { transcript: string };
}
interface SpeechEventLike extends Event {
  resultIndex: number;
  results: ArrayLike<SpeechResultLike>;
}
interface SpeechErrorEventLike extends Event {
  error: string;
  message?: string;
}
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechEventLike) => void) | null;
  onerror: ((event: SpeechErrorEventLike) => void) | null;
  onend: (() => void) | null;
  onspeechstart: (() => void) | null;
}
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface RealtimeEvent {
  type: string;
  response_id?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  delta?: string;
  transcript?: string;
  item_id?: string;
  response?: {
    id?: string;
    status?: string;
    metadata?: Record<string, unknown>;
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
      content?: Array<{ transcript?: string }>;
    }>;
  };
}

interface CallTranscriptEntry {
  id: string;
  speaker: "user" | "agent" | "system";
  text: string;
  final: boolean;
}

interface ActiveRealtimeConsult {
  toolCallId: string;
  responseId: string | null;
  abortController: AbortController;
}

interface RealtimeProgressCue {
  cueId: string;
  toolCallId: string | null;
  responseId: string | null;
  speechStoppedAt: number;
  requestedAt: number;
  audioAt: number | null;
  done: boolean;
}

interface RealtimeInterruptionTiming {
  detectedAt: number;
  mutedAt: number;
  toolCallId: string | null;
}

interface RealtimeTurnTiming {
  turn: number;
  outcome: RealtimeVoiceOutcome;
  speechStoppedAt: number | null;
  toolCallAt: number;
  progressRequestedAt: number | null;
  progressAudioAt: number | null;
  consultStartedAt: number | null;
  consultAcceptedAt: number | null;
  answerReadyAt: number | null;
  responseRequestedAt: number | null;
  firstAudioAt: number | null;
  queueWaitMs: number | null;
  agentProcessingMs: number | null;
  backendTotalMs: number | null;
  interruptionToMuteMs: number | null;
  interruptionToBufferClearedMs: number | null;
}

interface RealtimeConsultStatusResponse {
  status?: "pending" | "done" | "failed" | "cancelled";
  answer?: string | null;
  error?: string | null;
  latency?: {
    queue_wait_ms?: number | null;
    agent_processing_ms?: number | null;
    backend_total_ms?: number | null;
  };
}

function performanceDuration(start: number | null, end: number | null): number | undefined {
  if (start == null || end == null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return Math.round(end - start);
}

function realtimeVoiceMetrics(timings: Map<string, RealtimeTurnTiming>): RealtimeVoiceLatencyMetric[] {
  return [...timings.values()]
    .sort((left, right) => left.turn - right.turn)
    .map((timing) => ({
      turn: timing.turn,
      outcome: timing.outcome,
      speech_to_ack_ms: performanceDuration(timing.speechStoppedAt, timing.progressAudioAt),
      ack_request_to_audio_ms: performanceDuration(timing.progressRequestedAt, timing.progressAudioAt),
      speech_to_tool_ms: performanceDuration(timing.speechStoppedAt, timing.toolCallAt),
      consult_accept_ms: performanceDuration(timing.consultStartedAt, timing.consultAcceptedAt),
      consult_round_trip_ms: performanceDuration(timing.consultStartedAt, timing.answerReadyAt),
      queue_wait_ms: timing.queueWaitMs ?? undefined,
      agent_processing_ms: timing.agentProcessingMs ?? undefined,
      backend_total_ms: timing.backendTotalMs ?? undefined,
      response_to_first_audio_ms: performanceDuration(timing.responseRequestedAt, timing.firstAudioAt),
      speech_to_first_audio_ms: performanceDuration(timing.speechStoppedAt, timing.firstAudioAt),
      interruption_to_mute_ms: timing.interruptionToMuteMs ?? undefined,
      interruption_to_buffer_cleared_ms: timing.interruptionToBufferClearedMs ?? undefined,
    }));
}

interface DraftAttachment {
  localId: string;
  conversationId: string;
  file: File | null;
  filename: string;
  mimeType: string;
  byteSize: number;
  previewUrl: string | null;
  status: "preparing" | "uploading" | "ready" | "error";
  stagedAttachmentId: string | null;
  attachment: ConversationAttachment | null;
  error: string | null;
  voiceNoteDurationMs: number | null;
}

interface ConversationTimelineItem {
  message: ConversationMessage;
  pending: PendingConversationMessage | null;
}

interface MessageSearchState {
  query: string;
  results: ConversationMessage[];
  loading: boolean;
  error: string | null;
  hasSearched: boolean;
}

function Avatar({ participant, large = false }: { participant: ConversationParticipant; large?: boolean }) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-center border font-semibold",
        participant.type === "agent" ? "border-sand bg-nearblack text-sand" : "border-[#d4cbbd] bg-[#e6ded0] text-charcoal",
        large ? "h-32 w-32 text-section" : "h-10 w-10 text-caption"
      )}
      aria-label={participant.display_name}
    >
      {initials(participant.display_name)}
    </div>
  );
}

function timeLabel(value: string) {
  return new Intl.DateTimeFormat("en-AU", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function fileSizeLabel(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function VoiceNoteRecorder({
  conversationId,
  disabled,
  onRecorded,
  onError,
  onRecordingChange,
}: {
  conversationId: string;
  disabled: boolean;
  onRecorded: (conversationId: string, file: File, durationMs: number) => void;
  onError: (message: string) => void;
  onRecordingChange: (recording: boolean) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const conversationIdRef = useRef(conversationId);
  const keepRecordingRef = useRef(false);
  const durationRef = useRef(0);

  const release = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    setRecording(false);
    setElapsedMs(0);
    onRecordingChange(false);
  }, [onRecordingChange]);

  const stop = useCallback((keep: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    keepRecordingRef.current = keep;
    durationRef.current = Math.min(
      MAX_CONVERSATION_VOICE_NOTE_DURATION_MS,
      Math.max(0, Date.now() - startedAtRef.current)
    );
    recorder.stop();
  }, []);

  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      const next = Math.min(MAX_CONVERSATION_VOICE_NOTE_DURATION_MS, Date.now() - startedAtRef.current);
      setElapsedMs(next);
      if (next >= MAX_CONVERSATION_VOICE_NOTE_DURATION_MS) stop(true);
    }, 250);
    return () => window.clearInterval(timer);
  }, [recording, stop]);

  useEffect(() => () => {
    keepRecordingRef.current = false;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    streamRef.current?.getTracks().forEach((track) => track.stop());
  }, []);

  async function start() {
    if (disabled || recording) return;
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      onError("Voice-note recording is not supported in this browser.");
      return;
    }
    const mimeType = ([
      "audio/mp4;codecs=mp4a.40.2",
      "audio/mp4",
      "audio/webm;codecs=opus",
      "audio/webm",
    ] as const).find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) {
      onError("This browser cannot create a supported voice-note format.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      keepRecordingRef.current = false;
      conversationIdRef.current = conversationId;
      streamRef.current = stream;
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => {
        onError("Voice-note recording failed. Please try again.");
        release();
      };
      recorder.onstop = () => {
        const keep = keepRecordingRef.current;
        const durationMs = durationRef.current;
        const normalizedMime = recorder.mimeType.split(";", 1)[0];
        const chunks = chunksRef.current;
        chunksRef.current = [];
        release();
        if (!keep) return;
        if (!isConversationVoiceNoteDuration(durationMs)) {
          onError("Voice notes must be at least a quarter of a second long.");
          return;
        }
        if (!isConversationVoiceNoteMime(normalizedMime)) {
          onError("This browser produced an unsupported voice-note format.");
          return;
        }
        const extension = voiceNoteExtension(normalizedMime);
        const filename = `Voice note ${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
        const file = new File(chunks, filename, { type: normalizedMime, lastModified: Date.now() });
        if (file.size < 1) {
          onError("The voice note was empty. Please record it again.");
          return;
        }
        onRecorded(conversationIdRef.current, file, durationMs);
      };
      startedAtRef.current = Date.now();
      durationRef.current = 0;
      setElapsedMs(0);
      setRecording(true);
      onRecordingChange(true);
      recorder.start(250);
    } catch {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      onError("Microphone access is required to record a voice note.");
    }
  }

  if (!recording) return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void start()}
      aria-label="Record voice note"
      className="flex h-11 w-11 items-center justify-center rounded-full border border-[#d7d0c5] text-lg text-nearblack hover:bg-[#f1ece3] disabled:opacity-40"
    >
      <span aria-hidden>●</span>
    </button>
  );

  return (
    <div className="flex min-w-0 flex-1 items-center gap-2 rounded-xl bg-red-50 px-3 py-2 text-red-800" role="status" aria-live="polite">
      <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-red-600" aria-hidden />
      <span className="min-w-0 flex-1 text-caption font-semibold">Recording · {voiceNoteDurationLabel(elapsedMs)}</span>
      <button type="button" onClick={() => stop(false)} className="min-h-11 rounded-lg px-3 py-2 text-caption hover:bg-red-100">Cancel</button>
      <button type="button" onClick={() => stop(true)} className="min-h-11 rounded-lg bg-red-700 px-3 py-2 text-caption font-semibold text-white">Finish</button>
    </div>
  );
}

function taskStatusLabel(task: AgentTask) {
  if (task.cancellation_requested_at && task.status === "running") return "Stopping";
  return {
    queued: "Queued",
    running: "Working",
    awaiting_approval: "Needs approval",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
  }[task.status];
}

function AgentTaskCard({
  task,
  compact = false,
  dark = false,
  onAction,
}: {
  task: AgentTask;
  compact?: boolean;
  dark?: boolean;
  onAction: (taskId: string, action: "cancel" | "approve" | "reject", artifactId?: string) => void;
}) {
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const latestEvent = task.events.at(-1);
  const active = task.status === "queued" || task.status === "running";
  return (
    <article className={clsx(
      "min-w-0 max-w-full overflow-hidden rounded-2xl border p-3",
      dark ? "border-white/15 bg-white/[0.06] text-white" : "border-[#d4cbbd] bg-white/65 text-nearblack",
    )}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className={clsx("text-[11px] font-semibold uppercase tracking-[0.13em]", dark ? "text-sand" : "text-charcoal/50") }>
            {taskStatusLabel(task)} · {task.model_tier} model
          </p>
          <h3 className="mt-1 break-words text-[17px] font-semibold leading-snug md:text-[18px]">{task.title}</h3>
        </div>
        {active && !confirmingCancel && (
          <button
            type="button"
            onClick={() => setConfirmingCancel(true)}
            disabled={Boolean(task.cancellation_requested_at)}
            className={clsx("shrink-0 rounded-full px-3 py-2 text-caption font-semibold", dark ? "bg-white/10 text-white/70" : "bg-[#eee8de] text-charcoal/70")}
          >
            {task.cancellation_requested_at ? "Stopping…" : "Cancel"}
          </button>
        )}
        {active && confirmingCancel && !task.cancellation_requested_at && (
          <div className="flex shrink-0 flex-col items-end gap-1" role="group" aria-label={`Confirm stopping ${task.title}`}>
            <span className={clsx("text-[11px] font-semibold", dark ? "text-white/65" : "text-charcoal/65")}>Stop this task?</span>
            <div className="flex gap-1.5">
              <button
                type="button"
                onClick={() => setConfirmingCancel(false)}
                className={clsx("rounded-full px-3 py-2 text-caption font-semibold", dark ? "bg-white/10 text-white" : "bg-[#eee8de] text-charcoal")}
              >
                Keep working
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingCancel(false);
                  onAction(task.id, "cancel");
                }}
                className="rounded-full bg-red-700 px-3 py-2 text-caption font-semibold text-white"
              >
                Stop task
              </button>
            </div>
          </div>
        )}
      </div>
      {!compact && <p className={clsx("mt-2 line-clamp-4 text-[15px] leading-relaxed", dark ? "text-white/70" : "text-charcoal/70")}>{task.objective}</p>}
      {(latestEvent || task.result_summary || task.error) && (
        <p className={clsx("mt-2 text-[14px] leading-relaxed", task.error ? "text-red-600" : dark ? "text-white/55" : "text-charcoal/55") }>
          {task.error ?? latestEvent?.label ?? task.result_summary}
        </p>
      )}
      {active && task.artifacts.length === 0 && !compact && (
        <div className={clsx("mt-4 rounded-xl border border-dashed p-4", dark ? "border-white/15 bg-black/15" : "border-[#d8d0c4] bg-[#f8f5ef]") }>
          <p className="text-[15px] font-medium">Preparing the first reviewable version…</p>
          <p className={clsx("mt-1 text-caption", dark ? "text-white/45" : "text-charcoal/45")}>The draft will appear here when it is ready to read.</p>
        </div>
      )}
      {task.artifacts.map((artifact) => {
        const content = normalizeAgentTaskArtifactContent(artifact.content);
        const recipient = typeof content.to === "string" ? content.to : null;
        const subject = typeof content.subject === "string" ? content.subject : null;
        return (
          <div key={artifact.id} className={clsx("mt-4 rounded-xl border p-4", dark ? "border-white/10 bg-black/20" : "border-[#ded7cd] bg-[#f8f5ef]") }>
            <p className="text-[18px] font-semibold leading-snug md:text-[19px]">{artifact.title}</p>
            {(recipient || subject) && (
              <p className={clsx("mt-1 text-[13px] leading-relaxed", dark ? "text-white/55" : "text-charcoal/55") }>
                {[recipient && `To: ${recipient}`, subject && `Subject: ${subject}`].filter(Boolean).join(" · ")}
              </p>
            )}
            <div className={clsx("mt-3 max-h-80 max-w-full overflow-y-auto whitespace-pre-wrap break-words font-sans text-[16px] leading-[1.55] md:text-[17px]", dark ? "text-white/85" : "text-charcoal/85") }>{agentTaskArtifactText(content)}</div>
            {task.status === "awaiting_approval" && artifact.status === "draft" && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button type="button" onClick={() => onAction(task.id, "reject", artifact.id)} className={clsx("min-h-11 rounded-lg border px-3 py-2 text-body", dark ? "border-white/20" : "border-[#cfc6b8]")}>Reject</button>
                <button type="button" onClick={() => onAction(task.id, "approve", artifact.id)} className={clsx("min-h-11 rounded-lg px-3 py-2 text-body font-semibold", dark ? "bg-sand text-nearblack" : "bg-nearblack text-white")}>Approve</button>
              </div>
            )}
            {artifact.status !== "draft" && <p className={clsx("mt-2 text-[10px] font-semibold uppercase tracking-[0.14em]", dark ? "text-sand" : "text-charcoal/45")}>{artifact.status}</p>}
          </div>
        );
      })}
    </article>
  );
}

async function probeConversationAttachment(
  conversationId: string,
  attachmentId: string
): Promise<ConversationUploadProbe<ConversationAttachment>> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), ATTACHMENT_FINALIZE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`/api/conversations/${conversationId}/attachments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ attachment_id: attachmentId }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as {
      attachment?: ConversationAttachment;
      error?: string;
    };
    if (response.ok && body.attachment) {
      return { status: "ready", value: body.attachment };
    }
    if (response.status >= 500) return { status: "pending" };
    return {
      status: "failed",
      error: new Error(body.error ?? "Could not finish upload"),
      recoverable: false,
    };
  } catch {
    return { status: "pending" };
  } finally {
    window.clearTimeout(timeout);
  }
}

function NewConversation({ people, onCreated, onClose }: {
  people: ConversationParticipant[];
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const createIntentRef = useRef<{ signature: string; id: string } | null>(null);
  const candidates = people.filter((person) => !person.is_self);

  async function createConversation(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0) return;
    setSaving(true);
    setError(null);
    const profileIds = selected.filter((key) => key.startsWith("human:")).map((key) => key.slice(6));
    const agentSlugs = selected.filter((key) => key.startsWith("agent:")).map((key) => key.slice(6)) as AgentSlug[];
    const signature = JSON.stringify({ selected: [...selected].sort(), title: title.trim() });
    if (createIntentRef.current?.signature !== signature) {
      createIntentRef.current = { signature, id: crypto.randomUUID() };
    }
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          profile_ids: profileIds,
          agent_slugs: agentSlugs,
          title,
          client_conversation_id: createIntentRef.current.id,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not create conversation");
      onCreated(body.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create conversation");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center overflow-y-auto bg-nearblack/60 p-3 md:p-4">
      <form onSubmit={createConversation} role="dialog" aria-modal="true" aria-labelledby="new-conversation-title" className="max-h-full w-full max-w-lg overflow-y-auto border border-[#d4cbbd] bg-[#f5f1e8] p-4 shadow-2xl md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="label-caps">New conversation</p>
            <h2 id="new-conversation-title" className="mt-2 font-display text-section text-nearblack">Who’s in this chat?</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="flex h-11 w-11 items-center justify-center text-charcoal/50 hover:text-charcoal">✕</button>
        </div>
        <div className="mt-5 max-h-72 space-y-2 overflow-y-auto">
          {candidates.map((person) => {
            const key = `${person.type}:${person.type === "agent" ? person.agent_slug : person.id}`;
            const checked = selected.includes(key);
            return (
              <label key={key} className={clsx("flex cursor-pointer items-center gap-3 border p-3", checked ? "border-nearblack bg-cream" : "border-[#dcd6cc] bg-white/40")}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => setSelected((value) => checked ? value.filter((item) => item !== key) : [...value, key])}
                  className="h-4 w-4 accent-[#1a1a1a]"
                />
                <Avatar participant={person} />
                <span className="min-w-0">
                  <span className="block text-body font-medium text-nearblack">{person.display_name}</span>
                  <span className="block text-caption text-charcoal/50">{person.type === "agent" ? person.role_label : "RESLU staff"}</span>
                </span>
              </label>
            );
          })}
        </div>
        {selected.length > 1 && (
          <label className="mt-4 block">
            <span className="label-caps">Group name (optional)</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} className="mt-2 w-full border border-[#cfc6b8] bg-white px-3 py-2 text-body outline-none focus:border-nearblack" placeholder="e.g. Friday studio" />
          </label>
        )}
        {error && <p className="mt-3 text-caption text-red-700">{error}</p>}
        <button disabled={saving || selected.length === 0} className="mt-5 w-full bg-nearblack px-4 py-3 text-subhead text-white disabled:opacity-30">
          {saving ? "Creating…" : "Start conversation"}
        </button>
      </form>
    </div>
  );
}

function ForwardMessageDialog({
  message,
  conversations,
  onClose,
  onForwarded,
}: {
  message: ConversationMessage;
  conversations: ConversationSummary[];
  onClose: () => void;
  onForwarded: (destinationIds: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intentRef = useRef<{ signature: string; id: string } | null>(null);
  const visible = useMemo(() => {
    const term = filter.trim().toLowerCase();
    if (!term) return conversations;
    return conversations.filter((conversation) => [
      conversation.display_title,
      ...conversation.participants.map((participant) => participant.display_name),
    ].some((value) => value.toLowerCase().includes(term)));
  }, [conversations, filter]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0 || saving) return;
    const destinationIds = [...selected].sort();
    const signature = JSON.stringify(destinationIds);
    if (intentRef.current?.signature !== signature) {
      intentRef.current = { signature, id: crypto.randomUUID() };
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/conversations/${message.conversation_id}/messages/${message.id}/forward`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            destination_conversation_ids: destinationIds,
            client_forward_id: intentRef.current.id,
          }),
        }
      );
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not forward this message");
      onForwarded(destinationIds);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not forward this message");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-nearblack/60 p-3 md:p-4">
      <form onSubmit={submit} role="dialog" aria-modal="true" aria-label="Forward message" className="flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[#d4cbbd] bg-[#f5f1e8] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#d4cbbd] p-4 md:p-5">
          <div className="min-w-0">
            <p className="label-caps">Forward message</p>
            <p className="mt-2 line-clamp-2 text-body leading-relaxed text-charcoal/65">{message.body}</p>
            {message.attachments.length > 0 && <p className="mt-1 text-caption text-charcoal/45">Includes {message.attachments.length} private attachment{message.attachments.length === 1 ? "" : "s"}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close forwarding" className="flex h-11 w-11 shrink-0 items-center justify-center text-charcoal/50 hover:text-charcoal">✕</button>
        </div>
        <div className="border-b border-[#d4cbbd] p-3 md:p-4">
          <label className="flex items-center gap-2 rounded-xl border border-[#d4cbbd] bg-white px-3 py-2 focus-within:border-nearblack">
            <span aria-hidden className="text-charcoal/40">⌕</span>
            <span className="sr-only">Search conversations to forward to</span>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search chats"
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[16px] text-nearblack outline-none placeholder:text-charcoal/40"
            />
          </label>
        </div>
        <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2 md:p-3">
          {visible.length === 0 && <p className="p-6 text-center text-body text-charcoal/50">No matching chats.</p>}
          {visible.map((conversation) => {
            const checked = selected.includes(conversation.id);
            const participant = conversation.participants.find((item) => !item.is_self) ?? conversation.participants[0];
            return (
              <label key={conversation.id} className={clsx("flex cursor-pointer items-center gap-3 rounded-xl border p-3", checked ? "border-nearblack bg-white" : "border-transparent hover:bg-white/50") }>
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!checked && selected.length >= 10}
                  onChange={() => setSelected((current) => checked
                    ? current.filter((id) => id !== conversation.id)
                    : [...current, conversation.id])}
                  className="h-4 w-4 shrink-0 accent-[#1a1a1a]"
                />
                {participant && <Avatar participant={participant} />}
                <span className="min-w-0 flex-1 truncate text-body font-medium text-nearblack">{conversation.display_title}</span>
              </label>
            );
          })}
        </div>
        <div className="border-t border-[#d4cbbd] p-3 md:p-4">
          {error && <p className="mb-3 text-caption text-red-700">{error}</p>}
          <button disabled={saving || selected.length === 0} className="min-h-12 w-full rounded-xl bg-nearblack px-4 py-3 text-subhead text-white disabled:opacity-30">
            {saving ? "Forwarding…" : selected.length === 0 ? "Choose chats" : `Forward to ${selected.length} chat${selected.length === 1 ? "" : "s"}`}
          </button>
        </div>
      </form>
    </div>
  );
}

function GroupDetailsDialog({
  conversation,
  participants,
  people,
  onClose,
  onChanged,
  onLeft,
}: {
  conversation: ConversationSummary;
  participants: ConversationParticipant[];
  people: ConversationParticipant[];
  onClose: () => void;
  onChanged: () => Promise<void>;
  onLeft: () => Promise<void>;
}) {
  const [title, setTitle] = useState(conversation.display_title);
  const [selectedToAdd, setSelectedToAdd] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actionIntentRef = useRef<{ signature: string; id: string } | null>(null);
  const self = participants.find((participant) => participant.type === "human" && participant.is_self);
  const canManage = Boolean(self?.is_admin);
  const participantKeys = new Set(participants.map((participant) => (
    participant.type === "agent" ? `agent:${participant.agent_slug}` : `human:${participant.id}`
  )));
  const candidates = people.filter((person) => {
    if (person.is_self) return false;
    const key = person.type === "agent" ? `agent:${person.agent_slug}` : `human:${person.id}`;
    return !participantKeys.has(key);
  });

  async function mutate(action: string, payload: Record<string, unknown>) {
    const signature = JSON.stringify(payload, Object.keys(payload).sort());
    if (actionIntentRef.current?.signature !== signature) {
      actionIntentRef.current = { signature, id: crypto.randomUUID() };
    }
    setBusyAction(action);
    setError(null);
    let applied = false;
    try {
      const response = await fetch(`/api/conversations/${conversation.id}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, client_action_id: actionIntentRef.current.id }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not update this group");
      applied = true;
      actionIntentRef.current = null;
      await onChanged();
      return true;
    } catch (reason) {
      if (applied) {
        setError("The group was updated, but this view could not refresh. Close and reopen the chat to see it.");
        return true;
      }
      setError(reason instanceof Error ? reason.message : "Could not update this group");
      return false;
    } finally {
      setBusyAction(null);
    }
  }

  async function renameGroup(event: FormEvent) {
    event.preventDefault();
    const normalized = title.trim();
    if (!normalized) return;
    await mutate("rename", { action: "rename", title: normalized });
  }

  async function addParticipants() {
    const profileIds = selectedToAdd.filter((key) => key.startsWith("human:")).map((key) => key.slice(6));
    const agentSlugs = selectedToAdd.filter((key) => key.startsWith("agent:")).map((key) => key.slice(6));
    if (await mutate("add", { action: "add", profile_ids: profileIds, agent_slugs: agentSlugs })) {
      setSelectedToAdd([]);
    }
  }

  async function removeParticipant(participant: ConversationParticipant) {
    if (!window.confirm(`Remove ${participant.display_name} from this group? Their access ends immediately.`)) return;
    await mutate(`remove:${participant.id}`, {
      action: "remove",
      ...(participant.type === "agent"
        ? { agent_slug: participant.agent_slug }
        : { profile_id: participant.id }),
    });
  }

  async function changeAdmin(participant: ConversationParticipant) {
    await mutate(`role:${participant.id}`, {
      action: "role",
      profile_id: participant.id,
      admin: !participant.is_admin,
    });
  }

  async function leaveGroup() {
    if (!window.confirm("Leave this group? You will immediately lose access to its messages and files.")) return;
    const payload = { action: "leave" };
    const signature = JSON.stringify(payload);
    if (actionIntentRef.current?.signature !== signature) {
      actionIntentRef.current = { signature, id: crypto.randomUUID() };
    }
    setBusyAction("leave");
    setError(null);
    let applied = false;
    try {
      const response = await fetch(`/api/conversations/${conversation.id}/group`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, client_action_id: actionIntentRef.current.id }),
      });
      const body = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not leave this group");
      applied = true;
      actionIntentRef.current = null;
      await onLeft();
    } catch (reason) {
      if (applied) {
        setError("You left the group, but this view could not refresh. Close and reopen Messages.");
        return;
      }
      setError(reason instanceof Error ? reason.message : "Could not leave this group");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center overflow-y-auto bg-nearblack/60 p-3 md:p-4">
      <div role="dialog" aria-modal="true" aria-label="Group details" className="flex max-h-full w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[#d4cbbd] bg-[#f5f1e8] shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-[#d4cbbd] p-4 md:p-5">
          <div>
            <p className="label-caps">Group details</p>
            <h2 className="mt-2 font-display text-section text-nearblack">{conversation.display_title}</h2>
            <p className="mt-1 text-caption text-charcoal/50">{participants.length} participant{participants.length === 1 ? "" : "s"}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close group details" className="flex h-11 w-11 shrink-0 items-center justify-center text-charcoal/50 hover:text-charcoal">✕</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-5">
          {canManage && (
            <form onSubmit={renameGroup} className="border-b border-[#d4cbbd] pb-5">
              <label className="label-caps" htmlFor="conversation-group-name">Group name</label>
              <div className="mt-2 flex gap-2">
                <input
                  id="conversation-group-name"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={200}
                  className="min-h-11 min-w-0 flex-1 rounded-xl border border-[#d4cbbd] bg-white px-3 text-[16px] text-nearblack outline-none focus:border-nearblack"
                />
                <button disabled={Boolean(busyAction) || !title.trim()} className="rounded-xl bg-nearblack px-4 text-body font-semibold text-white disabled:opacity-30">
                  Save
                </button>
              </div>
            </form>
          )}

          <section className={clsx(canManage && "pt-5")} aria-label="Group participants">
            <p className="label-caps">Participants</p>
            <div className="mt-3 space-y-2">
              {participants.map((participant) => (
                <div key={`${participant.type}:${participant.id}`} className="flex items-center gap-3 rounded-xl border border-[#ded7cc] bg-white/55 p-3">
                  <Avatar participant={participant} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body font-medium text-nearblack">{participant.display_name}{participant.is_self ? " · You" : ""}</p>
                    <p className="mt-0.5 text-caption text-charcoal/50">{participant.type === "agent" ? "RESLU agent" : participant.is_admin ? "Group admin" : "Member"}</p>
                  </div>
                  {canManage && !participant.is_self && participant.type === "human" && (
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() => void changeAdmin(participant)}
                      className="shrink-0 rounded-full border border-[#d4cbbd] px-3 py-2 text-caption text-charcoal disabled:opacity-30"
                    >
                      {participant.is_admin ? "Remove admin" : "Make admin"}
                    </button>
                  )}
                  {canManage && !participant.is_self && (
                    <button
                      type="button"
                      disabled={Boolean(busyAction)}
                      onClick={() => void removeParticipant(participant)}
                      aria-label={`Remove ${participant.display_name}`}
                      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-red-700 hover:bg-red-50 disabled:opacity-30"
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>
          </section>

          {canManage && candidates.length > 0 && (
            <section className="mt-6 border-t border-[#d4cbbd] pt-5" aria-label="Add group participants">
              <div className="flex items-end justify-between gap-3">
                <div>
                  <p className="label-caps">Add people or agents</p>
                  <p className="mt-1 text-caption text-charcoal/50">New members can read the existing RESLU group history.</p>
                </div>
                <button
                  type="button"
                  disabled={Boolean(busyAction) || selectedToAdd.length === 0}
                  onClick={() => void addParticipants()}
                  className="rounded-xl bg-nearblack px-4 py-2.5 text-caption font-semibold text-white disabled:opacity-30"
                >
                  Add {selectedToAdd.length || ""}
                </button>
              </div>
              <div className="mt-3 max-h-56 space-y-1 overflow-y-auto">
                {candidates.map((person) => {
                  const key = person.type === "agent" ? `agent:${person.agent_slug}` : `human:${person.id}`;
                  const checked = selectedToAdd.includes(key);
                  return (
                    <label key={key} className={clsx("flex cursor-pointer items-center gap-3 rounded-xl p-3", checked ? "bg-white" : "hover:bg-white/50") }>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => setSelectedToAdd((current) => checked ? current.filter((item) => item !== key) : [...current, key])}
                        className="h-4 w-4 accent-[#1a1a1a]"
                      />
                      <Avatar participant={person} />
                      <span className="min-w-0 flex-1 truncate text-body text-nearblack">{person.display_name}</span>
                    </label>
                  );
                })}
              </div>
            </section>
          )}

          <section className="mt-6 border-t border-[#d4cbbd] pt-5">
            <button
              type="button"
              disabled={Boolean(busyAction)}
              onClick={() => void leaveGroup()}
              className="min-h-11 w-full rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-body font-semibold text-red-800 disabled:opacity-30"
            >
              Leave group
            </button>
          </section>
          {error && <p className="mt-4 text-caption text-red-700">{error}</p>}
        </div>
      </div>
    </div>
  );
}

export function ConversationWorkspace({
  presentation = "page",
  active = true,
  onCallActiveChange,
  callCompact = false,
  onCallCompactChange,
  onUnreadCountChange,
}: {
  presentation?: "page" | "drawer";
  active?: boolean;
  onCallActiveChange?: (active: boolean) => void;
  callCompact?: boolean;
  onCallCompactChange?: (compact: boolean) => void;
  onUnreadCountChange?: (count: number) => void;
} = {}) {
  const [data, setData] = useState<ConversationsResponse>({ conversations: [], people: [] });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [pinnedMessages, setPinnedMessages] = useState<ConversationMessage[]>([]);
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [agentActivity, setAgentActivity] = useState<ConversationAgentActivity[]>([]);
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});
  const [outbox, setOutbox] = useState<PendingConversationMessage[]>([]);
  const [online, setOnline] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [conversationFilter, setConversationFilter] = useState("");
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const [groupDetailsOpen, setGroupDetailsOpen] = useState(false);
  const [preferenceSaving, setPreferenceSaving] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const [messageSearch, setMessageSearch] = useState<MessageSearchState>({
    query: "",
    results: [],
    loading: false,
    error: null,
    hasSearched: false,
  });
  const [historyAnchorMessageId, setHistoryAnchorMessageId] = useState<string | null>(null);
  const [hasOlderMessages, setHasOlderMessages] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [replyingTo, setReplyingTo] = useState<ConversationMessage | null>(null);
  const [messageMenuId, setMessageMenuId] = useState<string | null>(null);
  const [mediaViewer, setMediaViewer] = useState<{ url: string; filename: string; author: string } | null>(null);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageBody, setEditingMessageBody] = useState("");
  const [messageMutationId, setMessageMutationId] = useState<string | null>(null);
  const [forwardingMessage, setForwardingMessage] = useState<ConversationMessage | null>(null);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [voiceNoteRecording, setVoiceNoteRecording] = useState(false);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [callOpening, setCallOpening] = useState(false);
  const [callState, setCallState] = useState<CallState>("connecting");
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [callError, setCallError] = useState<string | null>(null);
  const [lastSpoken, setLastSpoken] = useState("");
  const [callTranscript, setCallTranscript] = useState<CallTranscriptEntry[]>([]);
  const [callTranscriptExpanded, setCallTranscriptExpanded] = useState(false);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [agentWorkExpanded, setAgentWorkExpanded] = useState(false);
  const [meetingModeOpen, setMeetingModeOpen] = useState(false);
  const [meetingSourceCallId, setMeetingSourceCallId] = useState<string | null>(null);
  const [meetingMinutesId, setMeetingMinutesId] = useState<string | null>(null);
  const drawer = presentation === "drawer";
  const unreadCount = useMemo(
    () => data.conversations.reduce((total, conversation) => total + conversation.unread_count, 0),
    [data.conversations],
  );
  const callTranscriptScrollerRef = useRef<HTMLDivElement>(null);
  const callTranscriptStickRef = useRef(true);
  const messagesScrollerRef = useRef<HTMLDivElement>(null);
  const shouldStickToBottomRef = useRef(true);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const draftAttachmentsRef = useRef<DraftAttachment[]>([]);
  const draftAttachmentsByConversationRef = useRef(new Map<string, DraftAttachment[]>());
  const draftAttachmentLoadSequenceRef = useRef(new Map<string, number>());
  const draftsByConversationRef = useRef<Record<string, string>>({});
  const outboxRef = useRef<PendingConversationMessage[]>([]);
  const outboxInFlightRef = useRef(new Set<string>());
  const outboxFlushInFlightRef = useRef(false);
  const lastOutboxCreatedAtMsRef = useRef(0);
  const completedOutboxIdsRef = useRef(new Set<string>());
  const selectedIdRef = useRef<string | null>(null);
  const hasInitialConversationSelectionRef = useRef(false);
  const requestedMessageIdRef = useRef<string | null>(null);
  const historyAnchorMessageIdRef = useRef<string | null>(null);
  const historyExpandedRef = useRef(false);
  const currentUserIdRef = useRef<string | null>(null);
  const cancelledDraftIdsRef = useRef(new Set<string>());
  const attachmentDragDepthRef = useRef(0);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionPausedRef = useRef(false);
  const callIdRef = useRef<string | null>(null);
  const clientCallIdRef = useRef<string | null>(null);
  const callConversationIdRef = useRef<string | null>(null);
  const callActiveRef = useRef(false);
  const mutedRef = useRef(false);
  const spokenIdsRef = useRef(new Set<string>());
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const microphoneStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const interactionActiveRef = useRef(active);
  const realtimeActiveRef = useRef(false);
  const realtimeConnectionGenerationRef = useRef(0);
  const realtimeReconnectAttemptsRef = useRef(0);
  const realtimeReconnectInFlightRef = useRef(false);
  const realtimeReconnectTimerRef = useRef<number | null>(null);
  const realtimeReconnectRunnerRef = useRef<() => Promise<void>>(async () => undefined);
  const activeResponseIdRef = useRef<string | null>(null);
  const activeOutputAudioResponseIdRef = useRef<string | null>(null);
  const activeRealtimeConsultRef = useRef<ActiveRealtimeConsult | null>(null);
  const cancelledResponseIdsRef = useRef(new Set<string>());
  const cancelledToolCallIdsRef = useRef(new Set<string>());
  const handledToolCallIdsRef = useRef(new Set<string>());
  const lastRealtimeSpeechStoppedAtRef = useRef<number | null>(null);
  const realtimeTurnSequenceRef = useRef(0);
  const realtimeTurnTimingsRef = useRef(new Map<string, RealtimeTurnTiming>());
  const realtimeResponseToolCallIdsRef = useRef(new Map<string, string>());
  const realtimeProgressResponseToolCallIdsRef = useRef(new Map<string, string>());
  const activeRealtimeProgressCueRef = useRef<RealtimeProgressCue | null>(null);
  const realtimeProgressResponseCueIdsRef = useRef(new Map<string, string>());
  const realtimeAudibleResponseIdsRef = useRef(new Set<string>());
  const pendingRealtimeInterruptionsRef = useRef(new Map<string, RealtimeInterruptionTiming>());
  const pendingSpokenToolCallIdRef = useRef<string | null>(null);
  const inputTranscriptByItemRef = useRef(new Map<string, string>());
  const lastReadMessageByConversationRef = useRef(new Map<string, string>());
  const messageSearchRequestRef = useRef(0);
  const conversationListRequestRef = useRef(0);
  const messageRequestSequenceRef = useRef(0);
  const activeMessageRequestRef = useRef(new Map<string, number>());
  const messageLongPressRef = useRef<{ timer: number; messageId: string; x: number; y: number } | null>(null);

  const cancelMessageLongPress = useCallback(() => {
    if (messageLongPressRef.current) window.clearTimeout(messageLongPressRef.current.timer);
    messageLongPressRef.current = null;
  }, []);

  const startMessageLongPress = useCallback((messageId: string, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, textarea, audio, select")) return;
    cancelMessageLongPress();
    const timer = window.setTimeout(() => {
      messageLongPressRef.current = null;
      setMessageMenuId(messageId);
      navigator.vibrate?.(10);
    }, CONVERSATION_MESSAGE_LONG_PRESS_MS);
    messageLongPressRef.current = { timer, messageId, x: event.clientX, y: event.clientY };
  }, [cancelMessageLongPress]);

  const moveMessageLongPress = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const activePress = messageLongPressRef.current;
    if (!activePress) return;
    if (conversationLongPressMoved(activePress.x, activePress.y, event.clientX, event.clientY)) cancelMessageLongPress();
  }, [cancelMessageLongPress]);

  useEffect(() => cancelMessageLongPress, [cancelMessageLongPress]);

  useEffect(() => {
    if (!mediaViewer) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setMediaViewer(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [mediaViewer]);

  const commitDraftAttachments = useCallback((
    update: (current: DraftAttachment[]) => DraftAttachment[],
    conversationId = selectedIdRef.current
  ) => {
    if (!conversationId) return [];
    const current = draftAttachmentsByConversationRef.current.get(conversationId) ?? [];
    const next = update(current);
    if (next.length > 0) draftAttachmentsByConversationRef.current.set(conversationId, next);
    else draftAttachmentsByConversationRef.current.delete(conversationId);
    if (selectedIdRef.current === conversationId) {
      draftAttachmentsRef.current = next;
      setDraftAttachments(next);
    }
    return next;
  }, []);

  const upsertCallTranscript = useCallback((entry: CallTranscriptEntry) => {
    setCallTranscript((current) => {
      const index = current.findIndex((candidate) => candidate.id === entry.id);
      if (index < 0) return [...current, entry].slice(-80);
      const next = [...current];
      next[index] = entry;
      return next;
    });
  }, []);

  useEffect(() => {
    const scroller = callTranscriptScrollerRef.current;
    if (!scroller || !callTranscriptStickRef.current) return;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
  }, [callTranscript]);

  const loadAgentTasks = useCallback(async (conversationId: string) => {
    const response = await fetch(`/api/conversations/${conversationId}/tasks`, { cache: "no-store" });
    const body = await response.json() as { tasks?: AgentTask[]; error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not load background tasks");
    if (selectedIdRef.current === conversationId) setAgentTasks(body.tasks ?? []);
  }, []);

  const updateAgentTask = useCallback(async (
    taskId: string,
    action: "cancel" | "approve" | "reject",
    artifactId?: string
  ) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId) return;
    const response = await fetch(`/api/conversations/${conversationId}/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, artifact_id: artifactId }),
    });
    const body = await response.json() as { error?: string };
    if (!response.ok) throw new Error(body.error ?? "Could not update task");
    await loadAgentTasks(conversationId);
  }, [loadAgentTasks]);

  const selectedConversation = useMemo(
    () => data.conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [data.conversations, selectedId]
  );
  const activeConversations = useMemo(
    () => data.conversations.filter((conversation) => !conversation.archived_at),
    [data.conversations]
  );
  const archivedConversations = useMemo(
    () => data.conversations.filter((conversation) => Boolean(conversation.archived_at)),
    [data.conversations]
  );
  const visibleConversations = showArchived ? archivedConversations : activeConversations;
  const filteredConversations = useMemo(() => {
    const term = conversationFilter.trim().toLowerCase();
    if (!term) return visibleConversations;
    return visibleConversations.filter((conversation) => [
      conversation.display_title,
      conversation.last_message?.body,
      draftsByConversation[conversation.id],
      ...conversation.participants.map((participant) => participant.display_name),
    ].some((value) => value?.toLowerCase().includes(term)));
  }, [conversationFilter, draftsByConversation, visibleConversations]);
  const draft = selectedId ? draftsByConversation[selectedId] ?? "" : "";
  const attachmentUploadInProgress = draftAttachments.some((item) => (
    item.status === "preparing" || item.status === "uploading"
  ));
  const attachmentUploadFailed = draftAttachments.some((item) => item.status === "error");
  const composerBusy = sending || attachmentUploadInProgress || voiceNoteRecording;
  const callAgent = participants.find((participant) => participant.type === "agent") ?? null;
  const visibleAgentTasks = useMemo(() => {
    const active = agentTasks.filter((task) => ["queued", "running", "awaiting_approval"].includes(task.status));
    const recent = agentTasks.filter((task) => !active.includes(task)).slice(0, Math.max(0, 4 - active.length));
    return [...active, ...recent].slice(0, 6);
  }, [agentTasks]);
  const latestCallTranscript = callTranscript.at(-1);
  const handleTaskAction = useCallback((taskId: string, action: "cancel" | "approve" | "reject", artifactId?: string) => {
    void updateAgentTask(taskId, action, artifactId).catch((reason) => {
      setError(reason instanceof Error ? reason.message : "Could not update background task");
    });
  }, [updateAgentTask]);
  const headerParticipant = callAgent
    ?? selectedConversation?.participants.find((participant) => !participant.is_self)
    ?? selectedConversation?.participants[0]
    ?? null;
  const selfParticipant = participants.find((participant) => participant.is_self)
    ?? selectedConversation?.participants.find((participant) => participant.is_self)
    ?? null;
  const timelineItems = useMemo<ConversationTimelineItem[]>(() => {
    const canonicalClientIds = new Set(messages.flatMap((message) => message.client_message_id ? [message.client_message_id] : []));
    const canonical = messages.map((message) => ({ message, pending: null }));
    if (!selectedId || !selfParticipant) return canonical;
    const optimistic = outbox
      .filter((entry) => entry.conversationId === selectedId && !canonicalClientIds.has(entry.clientMessageId))
      .map((entry): ConversationTimelineItem => ({
        pending: entry,
        message: {
          id: `pending:${entry.clientMessageId}`,
          client_message_id: entry.clientMessageId,
          conversation_id: entry.conversationId,
          author_profile_id: selfParticipant.id,
          author_agent_id: null,
          kind: "text",
          body: entry.body,
          metadata: { source: entry.source },
          reply_to_id: entry.replyToId ?? null,
          created_at: entry.createdAt,
          edited_at: null,
          deleted_at: null,
          reactions: [],
          pinned_at: null,
          pinned_by: null,
          attachments: entry.attachments,
          author: selfParticipant,
        },
      }));
    return [...canonical, ...optimistic].sort((left, right) => (
      left.message.created_at.localeCompare(right.message.created_at)
      || left.message.id.localeCompare(right.message.id)
    ));
  }, [messages, outbox, selectedId, selfParticipant]);
  const timelineMessageById = useMemo(
    () => new Map(timelineItems.map((item) => [item.message.id, item.message])),
    [timelineItems]
  );
  const latestOutboxByConversation = useMemo(() => {
    const latest = new Map<string, PendingConversationMessage>();
    for (const entry of outbox) latest.set(entry.conversationId, entry);
    return latest;
  }, [outbox]);

  const loadConversations = useCallback(async (options?: { preserveError?: boolean }) => {
    const requestNumber = conversationListRequestRef.current + 1;
    conversationListRequestRef.current = requestNumber;
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load conversations");
      if (conversationListRequestRef.current !== requestNumber) return;
      const conversationData = body as ConversationsResponse;
      const signedInProfileId = conversationData.people.find((person) => person.is_self)?.id ?? null;
      currentUserIdRef.current = signedInProfileId;
      setCurrentUserId(signedInProfileId);
      setData(conversationData);
      setSelectedId((current) => {
        const currentStillExists = Boolean(
          current && conversationData.conversations.some((conversation) => conversation.id === current)
        );
        const next = currentStillExists
          ? current
          : hasInitialConversationSelectionRef.current
            ? null
            : conversationData.conversations.find((conversation) => !conversation.archived_at)?.id ?? null;
        hasInitialConversationSelectionRef.current = true;
        selectedIdRef.current = next;
        return next;
      });
      if (!options?.preserveError) setError(null);
    } catch (reason) {
      if (conversationListRequestRef.current !== requestNumber) return;
      setError(reason instanceof Error ? reason.message : "Could not load conversations");
    } finally {
      if (conversationListRequestRef.current === requestNumber) setLoading(false);
    }
  }, []);

  const speak = useCallback((body: string) => {
    if (!("speechSynthesis" in window)) return;
    window.speechSynthesis.cancel();
    // iOS cannot reliably play speech while its recognition audio session is
    // still recording. Pause recognition for the reply, then resume the call.
    recognitionPausedRef.current = true;
    recognitionRef.current?.abort();
    const utterance = new SpeechSynthesisUtterance(body);
    const preferred = callAgent?.agent_slug === "marco" ? /daniel|male|australia/i : /samantha|female|australia/i;
    utterance.voice = window.speechSynthesis.getVoices().find((voice) => preferred.test(`${voice.name} ${voice.lang}`)) ?? null;
    utterance.rate = 1;
    utterance.onstart = () => setCallState("speaking");
    const resumeListening = () => {
      recognitionPausedRef.current = false;
      if (!callActiveRef.current || mutedRef.current) return;
      try { recognitionRef.current?.start(); } catch { /* already restarting */ }
      setCallState("listening");
    };
    utterance.onend = resumeListening;
    utterance.onerror = resumeListening;
    setLastSpoken(body);
    window.speechSynthesis.resume();
    window.speechSynthesis.speak(utterance);
  }, [callAgent?.agent_slug]);

  const markConversationRead = useCallback(async (conversationId: string, throughMessageId: string) => {
    if (!interactionActiveRef.current || document.visibilityState !== "visible") return;
    if (lastReadMessageByConversationRef.current.get(conversationId) === throughMessageId) return;
    lastReadMessageByConversationRef.current.set(conversationId, throughMessageId);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/read`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ through_message_id: throughMessageId }),
      });
      if (!response.ok) throw new Error("Could not update read state");
      void loadConversations({ preserveError: true });
    } catch {
      lastReadMessageByConversationRef.current.delete(conversationId);
    }
  }, [loadConversations]);

  const loadMessages = useCallback(async (
    conversationId: string,
    options?: { around?: string; before?: { createdAt: string; id: string }; latest?: boolean; mergeOlder?: boolean }
  ) => {
    if (!options && activeMessageRequestRef.current.has(conversationId)) return;
    const requestNumber = messageRequestSequenceRef.current + 1;
    messageRequestSequenceRef.current = requestNumber;
    activeMessageRequestRef.current.set(conversationId, requestNumber);
    try {
      const anchorMessageId = options?.latest || options?.before
        ? null
        : options?.around ?? historyAnchorMessageIdRef.current;
      const parameters = new URLSearchParams();
      if (anchorMessageId) parameters.set("around", anchorMessageId);
      if (options?.before) {
        parameters.set("before", options.before.createdAt);
        parameters.set("before_id", options.before.id);
      }
      const query = parameters.size > 0 ? `?${parameters.toString()}` : "";
      const response = await fetch(`/api/conversations/${conversationId}/messages${query}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load messages");
      if (
        selectedIdRef.current !== conversationId
        || activeMessageRequestRef.current.get(conversationId) !== requestNumber
      ) return;
      const incoming = body.messages as ConversationMessage[];
      historyAnchorMessageIdRef.current = anchorMessageId;
      setHistoryAnchorMessageId(anchorMessageId);
      const shouldMerge = options?.mergeOlder || (!anchorMessageId && historyExpandedRef.current && !options?.latest);
      if (shouldMerge) {
        setMessages((current) => {
          const merged = new Map(current.map((message) => [message.id, message]));
          for (const message of incoming) merged.set(message.id, message);
          return [...merged.values()].sort((left, right) => (
            left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
          ));
        });
      } else {
        setMessages(incoming);
      }
      if (options?.latest) historyExpandedRef.current = false;
      if (options?.mergeOlder) historyExpandedRef.current = true;
      if (!historyExpandedRef.current || options?.mergeOlder || options?.latest || anchorMessageId) {
        setHasOlderMessages(Boolean(body.context?.has_older));
      }
      setParticipants(body.participants);
      setAgentActivity(Array.isArray(body.agent_activity) ? body.agent_activity as ConversationAgentActivity[] : []);
      setPinnedMessages(Array.isArray(body.pinned_messages) ? body.pinned_messages as ConversationMessage[] : []);
      const requestedMessage = requestedMessageIdRef.current
        ? incoming.find((message) => message.id === requestedMessageIdRef.current)
        : null;
      const newestReadableMessage = shouldStickToBottomRef.current
        ? incoming.findLast((message) => !message.deleted_at) ?? null
        : null;
      const readThroughMessage = requestedMessage?.deleted_at ? null : requestedMessage ?? newestReadableMessage;
      if (readThroughMessage) {
        void markConversationRead(conversationId, readThroughMessage.id);
      }
      const confirmedClientIds = new Set(incoming.flatMap((message) => message.client_message_id ? [message.client_message_id] : []));
      if (confirmedClientIds.size > 0) {
        const confirmedOutboxIds = outboxRef.current
          .filter((entry) => confirmedClientIds.has(entry.clientMessageId))
          .map((entry) => entry.clientMessageId);
        const remaining = outboxRef.current.filter((entry) => !confirmedClientIds.has(entry.clientMessageId));
        if (remaining.length !== outboxRef.current.length) {
          confirmedOutboxIds.forEach((clientMessageId) => completedOutboxIdsRef.current.add(clientMessageId));
          outboxRef.current = remaining;
          setOutbox(remaining);
          for (const clientMessageId of confirmedOutboxIds) {
            void removePendingConversationMessage(clientMessageId).catch(() => null);
          }
        }
      }
      if (callActiveRef.current && !realtimeActiveRef.current) {
        const unsaid = incoming.filter((message) => message.author.type === "agent" && !spokenIdsRef.current.has(message.id));
        incoming.forEach((message) => spokenIdsRef.current.add(message.id));
        const newest = unsaid.at(-1);
        if (newest) speak(newest.body);
      } else {
        incoming.forEach((message) => spokenIdsRef.current.add(message.id));
      }
    } catch (reason) {
      if (activeMessageRequestRef.current.get(conversationId) === requestNumber) {
        setError(reason instanceof Error ? reason.message : "Could not load messages");
      }
    } finally {
      if (activeMessageRequestRef.current.get(conversationId) === requestNumber) {
        activeMessageRequestRef.current.delete(conversationId);
      }
    }
  }, [markConversationRead, speak]);

  const updateDraft = useCallback((conversationId: string, value: string) => {
    const next = { ...draftsByConversationRef.current, [conversationId]: value };
    draftsByConversationRef.current = next;
    setDraftsByConversation(next);
    const ownerProfileId = currentUserIdRef.current;
    if (!ownerProfileId) return;
    void saveConversationDraft(ownerProfileId, conversationId, value).catch(() => {
      setError("This draft could not be saved on this device.");
    });
  }, []);

  const clearDraft = useCallback((conversationId: string, sentBody?: string) => {
    if (sentBody !== undefined && (draftsByConversationRef.current[conversationId] ?? "") !== sentBody) return;
    const next = { ...draftsByConversationRef.current };
    delete next[conversationId];
    draftsByConversationRef.current = next;
    setDraftsByConversation(next);
    const ownerProfileId = currentUserIdRef.current;
    if (ownerProfileId) void removeConversationDraft(ownerProfileId, conversationId).catch(() => null);
  }, []);

  const persistOutboxEntry = useCallback(async (entry: PendingConversationMessage) => {
    completedOutboxIdsRef.current.delete(entry.clientMessageId);
    const next = mergePendingConversationMessages(
      outboxRef.current.filter((item) => item.clientMessageId !== entry.clientMessageId),
      [entry]
    );
    outboxRef.current = next;
    setOutbox(next);
    await savePendingConversationMessage(entry);
  }, []);

  const discardOutboxEntry = useCallback(async (clientMessageId: string) => {
    completedOutboxIdsRef.current.add(clientMessageId);
    const next = outboxRef.current.filter((entry) => entry.clientMessageId !== clientMessageId);
    outboxRef.current = next;
    setOutbox(next);
    await removePendingConversationMessage(clientMessageId);
  }, []);

  const dispatchOutboxEntry = useCallback(async (entry: PendingConversationMessage) => {
    if (outboxInFlightRef.current.has(entry.clientMessageId)) return;
    if (!navigator.onLine) {
      if (entry.status !== "queued") {
        await persistOutboxEntry({ ...entry, status: "queued", error: null, retryable: true }).catch(() => null);
      }
      return;
    }

    outboxInFlightRef.current.add(entry.clientMessageId);
    const sendingEntry: PendingConversationMessage = { ...entry, status: "sending", error: null, retryable: true };
    await persistOutboxEntry(sendingEntry).catch(() => null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), MESSAGE_SEND_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/conversations/${entry.conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          body: entry.body,
          source: entry.source,
          target_agent_slugs: entry.targetAgent ? [entry.targetAgent] : undefined,
          attachment_ids: entry.attachmentIds,
          client_message_id: entry.clientMessageId,
          reply_to_id: entry.replyToId,
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        await persistOutboxEntry({
          ...entry,
          status: "failed",
          error: typeof result.error === "string" ? result.error : "Message was not sent.",
          retryable,
        }).catch(() => null);
        return;
      }

      const canonical = {
        ...(result.message as ConversationMessage),
        client_message_id: entry.clientMessageId,
        attachments: entry.attachments,
      };
      if (selectedIdRef.current === entry.conversationId) {
        setMessages((current) => [
          ...current.filter((message) => message.id !== canonical.id && message.client_message_id !== entry.clientMessageId),
          canonical,
        ].sort((left, right) => (
          left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)
        )));
      }
      shouldStickToBottomRef.current = true;
      await discardOutboxEntry(entry.clientMessageId).catch(() => null);
      void loadConversations();
      if (result.queue_error) {
        setError(`Message delivered, but ${entry.targetAgent ? entry.targetAgent[0].toUpperCase() + entry.targetAgent.slice(1) : "the agent"} could not be notified yet.`);
      }
    } catch (reason) {
      const offline = !navigator.onLine;
      const timedOut = reason instanceof DOMException && reason.name === "AbortError";
      await persistOutboxEntry({
        ...entry,
        status: offline ? "queued" : "failed",
        error: offline ? null : timedOut ? "Delivery confirmation timed out. It is safe to retry." : reason instanceof Error ? reason.message : "Message was not sent.",
        retryable: true,
      }).catch(() => null);
    } finally {
      window.clearTimeout(timeout);
      outboxInFlightRef.current.delete(entry.clientMessageId);
    }
  }, [discardOutboxEntry, loadConversations, persistOutboxEntry]);

  const flushOutbox = useCallback(async () => {
    const ownerProfileId = currentUserIdRef.current;
    if (!ownerProfileId || outboxFlushInFlightRef.current || !navigator.onLine) return;
    outboxFlushInFlightRef.current = true;
    const attempted = new Set<string>();
    try {
      while (navigator.onLine) {
        const stored = (await listPendingConversationMessages())
          .filter((entry) => entry.ownerProfileId === ownerProfileId && !completedOutboxIdsRef.current.has(entry.clientMessageId))
          .map(recoverPendingConversationMessage);
        const next = mergePendingConversationMessages(stored, outboxRef.current);
        outboxRef.current = next;
        setOutbox(next);
        const entry = next.find((candidate) =>
          !attempted.has(candidate.clientMessageId)
          && (candidate.status === "queued" || (candidate.status === "failed" && candidate.retryable))
        );
        if (!entry) break;
        attempted.add(entry.clientMessageId);
        await dispatchOutboxEntry(entry);
        const current = outboxRef.current.find((candidate) => candidate.clientMessageId === entry.clientMessageId);
        if (current && (current.status === "queued" || (current.status === "failed" && current.retryable))) {
          // Preserve the visible send order across a transport outage. A
          // permanent validation failure may be skipped, but a retryable
          // earlier message must not be overtaken by a later one.
          break;
        }
      }
    } catch {
      setError("Queued messages could not be read from this device.");
    } finally {
      outboxFlushInFlightRef.current = false;
    }
  }, [dispatchOutboxEntry]);

  const retryOutboxEntry = useCallback((entry: PendingConversationMessage) => {
    const queued = { ...entry, status: "queued" as const, error: null, retryable: true };
    void persistOutboxEntry(queued).then(() => flushOutbox());
  }, [flushOutbox, persistOutboxEntry]);

  const copyTextToClipboard = useCallback(async (text: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
      const fallback = document.createElement("textarea");
      fallback.value = text;
      fallback.setAttribute("readonly", "");
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.appendChild(fallback);
      fallback.select();
      const copied = document.execCommand("copy");
      fallback.remove();
      return copied;
    } catch {
      return false;
    }
  }, []);

  const copyOutboxEntry = useCallback(async (entry: PendingConversationMessage) => {
    if (!await copyTextToClipboard(entry.body)) {
      setError("Could not copy this message. Press and hold the text to copy it manually.");
    }
  }, [copyTextToClipboard]);

  const copyCanonicalMessage = useCallback(async (message: ConversationMessage) => {
    setMessageMenuId(null);
    if (!await copyTextToClipboard(message.body)) {
      setError("Could not copy this message. Press and hold the text to copy it manually.");
    }
  }, [copyTextToClipboard]);

  const beginReply = useCallback((message: ConversationMessage) => {
    setReplyingTo(message);
    setMessageMenuId(null);
    window.setTimeout(() => composerInputRef.current?.focus(), 0);
  }, []);

  const applyMessageMutation = useCallback((message: ConversationMessage) => {
    setMessages((current) => current.map((candidate) => candidate.id === message.id ? message : candidate));
    setPinnedMessages((current) => message.pinned_at
      ? current.map((candidate) => candidate.id === message.id ? message : candidate)
      : current.filter((candidate) => candidate.id !== message.id));
    if (message.deleted_at) {
      setReplyingTo((current) => current?.id === message.id ? null : current);
      setEditingMessageId((current) => current === message.id ? null : current);
    }
    void loadConversations({ preserveError: true });
  }, [loadConversations]);

  const beginMessageEdit = useCallback((message: ConversationMessage) => {
    setMessageMenuId(null);
    setEditingMessageId(message.id);
    setEditingMessageBody(message.body);
  }, []);

  const cancelMessageEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditingMessageBody("");
  }, []);

  const saveMessageEdit = useCallback(async (message: ConversationMessage) => {
    if (!selectedIdRef.current || messageMutationId || editingMessageId !== message.id) return;
    const normalized = editingMessageBody.trim();
    if (!normalized) {
      setError("A message cannot be empty.");
      return;
    }
    setMessageMutationId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${selectedIdRef.current}/messages/${message.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          body: normalized,
          expected_version: message.edited_at ?? message.created_at,
        }),
      });
      const result = await response.json().catch(() => ({})) as { message?: ConversationMessage; error?: string };
      if (!response.ok || !result.message) throw new Error(result.error ?? "Could not edit this message");
      applyMessageMutation(result.message);
      cancelMessageEdit();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not edit this message");
    } finally {
      setMessageMutationId(null);
    }
  }, [applyMessageMutation, cancelMessageEdit, editingMessageBody, editingMessageId, messageMutationId]);

  const deleteMessageRecoverably = useCallback(async (message: ConversationMessage) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || messageMutationId) return;
    setMessageMenuId(null);
    if (!window.confirm("Delete this message for everyone? You can restore it for 30 days.")) return;
    setMessageMutationId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}`, { method: "DELETE" });
      const result = await response.json().catch(() => ({})) as { message?: ConversationMessage; error?: string };
      if (!response.ok || !result.message) throw new Error(result.error ?? "Could not delete this message");
      applyMessageMutation(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not delete this message");
    } finally {
      setMessageMutationId(null);
    }
  }, [applyMessageMutation, messageMutationId]);

  const restoreMessage = useCallback(async (message: ConversationMessage) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || messageMutationId) return;
    setMessageMenuId(null);
    setMessageMutationId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore" }),
      });
      const result = await response.json().catch(() => ({})) as { message?: ConversationMessage; error?: string };
      if (!response.ok || !result.message) throw new Error(result.error ?? "Could not restore this message");
      applyMessageMutation(result.message);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not restore this message");
    } finally {
      setMessageMutationId(null);
    }
  }, [applyMessageMutation, messageMutationId]);

  const toggleMessageReaction = useCallback(async (
    message: ConversationMessage,
    reaction: ConversationMessageReactionValue
  ) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || messageMutationId) return;
    setMessageMenuId(null);
    setMessageMutationId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/reaction`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reaction }),
      });
      const result = await response.json().catch(() => ({})) as { reactions?: ConversationMessage["reactions"]; error?: string };
      if (!response.ok || !result.reactions) throw new Error(result.error ?? "Could not update reaction");
      setMessages((current) => current.map((candidate) => candidate.id === message.id
        ? { ...candidate, reactions: result.reactions! }
        : candidate));
      setPinnedMessages((current) => current.map((candidate) => candidate.id === message.id
        ? { ...candidate, reactions: result.reactions! }
        : candidate));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update reaction");
    } finally {
      setMessageMutationId(null);
    }
  }, [messageMutationId]);

  const toggleMessagePin = useCallback(async (message: ConversationMessage) => {
    const conversationId = selectedIdRef.current;
    if (!conversationId || messageMutationId) return;
    const nextPinned = !message.pinned_at;
    setMessageMenuId(null);
    setMessageMutationId(message.id);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages/${message.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: nextPinned }),
      });
      const result = await response.json().catch(() => ({})) as { pinned_at?: string | null; pinned_by?: string | null; error?: string };
      if (!response.ok || !("pinned_at" in result)) throw new Error(result.error ?? "Could not update pinned message");
      const updated = { ...message, pinned_at: result.pinned_at ?? null, pinned_by: result.pinned_by ?? null };
      setMessages((current) => current.map((candidate) => candidate.id === message.id ? updated : candidate));
      setPinnedMessages((current) => result.pinned_at
        ? [updated, ...current.filter((candidate) => candidate.id !== message.id)].slice(0, 5)
        : current.filter((candidate) => candidate.id !== message.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update pinned message");
    } finally {
      setMessageMutationId(null);
    }
  }, [messageMutationId]);

  const discardFailedOutboxEntry = useCallback((entry: PendingConversationMessage) => {
    if (!window.confirm("Discard this unsent message from this device?")) return;
    void discardOutboxEntry(entry.clientMessageId).catch(() => {
      setError("This unsent message could not be removed from the device.");
    });
  }, [discardOutboxEntry]);

  useEffect(() => {
    const updateConnectionState = () => setOnline(navigator.onLine);
    updateConnectionState();
    window.addEventListener("online", updateConnectionState);
    window.addEventListener("offline", updateConnectionState);
    return () => {
      window.removeEventListener("online", updateConnectionState);
      window.removeEventListener("offline", updateConnectionState);
    };
  }, []);
  useEffect(() => {
    if (!currentUserId) return;
    let active = true;
    draftsByConversationRef.current = {};
    setDraftsByConversation({});
    outboxRef.current = [];
    setOutbox([]);
    completedOutboxIdsRef.current.clear();
    lastOutboxCreatedAtMsRef.current = 0;
    const initialise = window.setTimeout(() => {
      void Promise.all([listConversationDrafts(currentUserId), listPendingConversationMessages()])
        .then(([storedDrafts, storedOutbox]) => {
          if (!active) return;
          const draftMap = Object.fromEntries(storedDrafts.map((item) => [item.conversationId, item.body]));
          const mergedDrafts = { ...draftMap, ...draftsByConversationRef.current };
          draftsByConversationRef.current = mergedDrafts;
          setDraftsByConversation(mergedDrafts);
          const recovered = mergePendingConversationMessages(
            storedOutbox.filter((entry) => entry.ownerProfileId === currentUserId).map(recoverPendingConversationMessage),
            outboxRef.current
          );
          lastOutboxCreatedAtMsRef.current = Math.max(
            lastOutboxCreatedAtMsRef.current,
            ...recovered.map((entry) => Date.parse(entry.createdAt)).filter(Number.isFinite),
            0
          );
          outboxRef.current = recovered;
          setOutbox(recovered);
          for (const entry of recovered) void savePendingConversationMessage(entry).catch(() => null);
          if (navigator.onLine) void flushOutbox();
        })
        .catch(() => {
          if (active) setError("Offline drafts and queued messages are unavailable on this device.");
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(initialise);
    };
  }, [currentUserId, flushOutbox]);
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const conversationId = search.get("conversation");
    const messageId = search.get("message");
    if (!conversationId || !UUID_PATTERN.test(conversationId)) return;
    hasInitialConversationSelectionRef.current = true;
    selectedIdRef.current = conversationId;
    setSelectedId(conversationId);
    if (messageId && UUID_PATTERN.test(messageId)) {
      requestedMessageIdRef.current = messageId;
      historyAnchorMessageIdRef.current = messageId;
      setHistoryAnchorMessageId(messageId);
      shouldStickToBottomRef.current = false;
    }
  }, []);
  useEffect(() => {
    const initial = window.setTimeout(() => void loadConversations(), 0);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadConversations({ preserveError: true });
    }, 10000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [loadConversations]);
  useEffect(() => {
    if (!selectedId) return;
    const initial = window.setTimeout(() => void loadMessages(selectedId), 0);
    const timer = window.setInterval(() => void loadMessages(selectedId), callActiveRef.current ? 1200 : 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [selectedId, loadMessages, callId]);
  useEffect(() => {
    if (!selectedId) {
      setAgentTasks([]);
      return;
    }
    const refresh = () => void loadAgentTasks(selectedId).catch(() => null);
    const initial = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, callId ? 1500 : 6000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(timer);
    };
  }, [callId, loadAgentTasks, selectedId]);
  useEffect(() => {
    if (!selectedId) return;
    const refreshVisibleConversation = () => {
      if (document.visibilityState === "visible") {
        void loadMessages(selectedId);
        void flushOutbox();
      }
    };
    window.addEventListener("focus", refreshVisibleConversation);
    window.addEventListener("online", refreshVisibleConversation);
    document.addEventListener("visibilitychange", refreshVisibleConversation);
    return () => {
      window.removeEventListener("focus", refreshVisibleConversation);
      window.removeEventListener("online", refreshVisibleConversation);
      document.removeEventListener("visibilitychange", refreshVisibleConversation);
    };
  }, [selectedId, loadMessages, flushOutbox]);
  useEffect(() => {
    // scrollIntoView() may move the page itself on iOS, taking the chat header
    // and call action off-screen. Scroll only the message pane so the mobile
    // conversation chrome stays pinned like a native messenger.
    const scroller = messagesScrollerRef.current;
    if (scroller && shouldStickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [timelineItems]);
  useEffect(() => {
    const requestedMessageId = requestedMessageIdRef.current;
    if (!requestedMessageId) return;
    const item = document.getElementById(`conversation-message-${requestedMessageId}`);
    if (!item) return;
    item.scrollIntoView({ block: "center", behavior: "smooth" });
    requestedMessageIdRef.current = null;
  }, [timelineItems]);
  useEffect(() => {
    selectedIdRef.current = selectedId;
    const activeDrafts = selectedId
      ? draftAttachmentsByConversationRef.current.get(selectedId) ?? []
      : [];
    draftAttachmentsRef.current = activeDrafts;
    setDraftAttachments(activeDrafts);
    shouldStickToBottomRef.current = !historyAnchorMessageIdRef.current;
    setConversationMenuOpen(false);
  }, [selectedId]);
  useEffect(() => {
    if (selectedConversation?.archived_at) setShowArchived(true);
  }, [selectedConversation?.archived_at]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { interactionActiveRef.current = active; }, [active]);

  useEffect(() => {
    onCallActiveChange?.(Boolean(callOpening || callId || callError));
  }, [callError, callId, callOpening, onCallActiveChange]);

  useEffect(() => {
    onUnreadCountChange?.(unreadCount);
  }, [onUnreadCountChange, unreadCount]);
  useEffect(() => () => {
    for (const drafts of draftAttachmentsByConversationRef.current.values()) {
      for (const item of drafts) {
        if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
      }
    }
    // Ready, unbound server rows deliberately survive navigation/reload and
    // are restored into their original chat. Old interrupted rows are still
    // bounded by the server's staged-attachment expiry cleanup.
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    const updateViewport = () => {
      const element = workspaceRef.current;
      if (!element) return;
      element.style.setProperty("--conversation-vh", `${viewport?.height ?? window.innerHeight}px`);
      element.style.setProperty("--conversation-vtop", `${viewport?.offsetTop ?? 0}px`);
    };
    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);
    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, []);

  const removeDraftAttachment = useCallback((localId: string) => {
    const draft = draftAttachmentsRef.current.find((item) => item.localId === localId);
    if (!draft) return;
    if (draft.status === "preparing" || draft.status === "uploading") {
      cancelledDraftIdsRef.current.add(localId);
    }
    if (draft.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(draft.previewUrl);
    commitDraftAttachments(
      (current) => current.filter((item) => item.localId !== localId),
      draft.conversationId
    );
    const attachmentId = draft.attachment?.id ?? draft.stagedAttachmentId;
    if (attachmentId) {
      void fetch(
        `/api/conversations/${draft.conversationId}/attachments?attachment_id=${encodeURIComponent(attachmentId)}`,
        { method: "DELETE" }
      ).catch(() => null);
    }
  }, [commitDraftAttachments]);

  const selectConversation = useCallback((conversationId: string | null) => {
    if (conversationId === selectedId) return;
    if (voiceNoteRecording) {
      setError("Finish or cancel the voice note before changing chats.");
      return;
    }
    if (sending) {
      setError("Wait for the message to finish sending before changing chats.");
      return;
    }
    const nextDraftAttachments = conversationId
      ? draftAttachmentsByConversationRef.current.get(conversationId) ?? []
      : [];
    draftAttachmentsRef.current = nextDraftAttachments;
    setDraftAttachments(nextDraftAttachments);
    setError(null);
    requestedMessageIdRef.current = null;
    historyAnchorMessageIdRef.current = null;
    historyExpandedRef.current = false;
    setHasOlderMessages(false);
    setHistoryAnchorMessageId(null);
    setMessageSearchOpen(false);
    setReplyingTo(null);
    setMessageMenuId(null);
    setEditingMessageId(null);
    setEditingMessageBody("");
    setAgentWorkExpanded(false);
    messageSearchRequestRef.current += 1;
    if (selectedId) activeMessageRequestRef.current.delete(selectedId);
    if (conversationId) activeMessageRequestRef.current.delete(conversationId);
    setMessageSearch({ query: "", results: [], loading: false, error: null, hasSearched: false });
    selectedIdRef.current = conversationId;
    setMessages([]);
    setPinnedMessages([]);
    setParticipants([]);
    setAgentActivity([]);
    setConversationMenuOpen(false);
    setSelectedId(conversationId);
  }, [selectedId, sending, voiceNoteRecording]);

  const updateConversationPreferences = useCallback(async (
    changes: { notifications_muted?: boolean; archived?: boolean; pinned?: boolean }
  ) => {
    if (!selectedId || preferenceSaving) return;
    setPreferenceSaving(true);
    setConversationMenuOpen(false);
    setError(null);
    try {
      const response = await fetch(`/api/conversations/${selectedId}/preferences`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(changes),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not update this conversation");
      const preferences = body.preferences as {
        notifications_muted: boolean;
        archived_at: string | null;
        pinned_at: string | null;
      };
      setData((current) => ({
        ...current,
        conversations: current.conversations.map((conversation) => conversation.id === selectedId
          ? { ...conversation, ...preferences }
          : conversation),
      }));
      if (changes.archived === true) setShowArchived(true);
      if (changes.archived === false || changes.pinned === true) setShowArchived(false);
      void loadConversations({ preserveError: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update this conversation");
    } finally {
      setPreferenceSaving(false);
    }
  }, [loadConversations, preferenceSaving, selectedId]);

  const runMessageSearch = useCallback(async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedId) return;
    const query = messageSearch.query.trim();
    if (query.length < 2) {
      setMessageSearch((current) => ({ ...current, error: "Enter at least 2 characters.", results: [], hasSearched: true }));
      return;
    }
    const requestNumber = messageSearchRequestRef.current + 1;
    messageSearchRequestRef.current = requestNumber;
    setMessageSearch((current) => ({ ...current, loading: true, error: null, hasSearched: true }));
    try {
      const response = await fetch(
        `/api/conversations/${selectedId}/search?q=${encodeURIComponent(query)}`,
        { cache: "no-store" }
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not search this conversation");
      if (messageSearchRequestRef.current !== requestNumber) return;
      setMessageSearch((current) => ({
        ...current,
        loading: false,
        error: null,
        results: body.results as ConversationMessage[],
      }));
    } catch (reason) {
      if (messageSearchRequestRef.current !== requestNumber) return;
      setMessageSearch((current) => ({
        ...current,
        loading: false,
        results: [],
        error: reason instanceof Error ? reason.message : "Could not search this conversation",
      }));
    }
  }, [messageSearch.query, selectedId]);

  const openMessageSearchResult = useCallback(async (messageId: string) => {
    if (!selectedId) return;
    requestedMessageIdRef.current = messageId;
    historyAnchorMessageIdRef.current = messageId;
    setHistoryAnchorMessageId(messageId);
    shouldStickToBottomRef.current = false;
    setMessageSearchOpen(false);
    try {
      await loadMessages(selectedId, { around: messageId });
    } catch {
      // loadMessages exposes its own user-facing error.
    }
  }, [loadMessages, selectedId]);

  const jumpToReferencedMessage = useCallback((messageId: string) => {
    const element = document.getElementById(`conversation-message-${messageId}`);
    if (element) {
      element.scrollIntoView({ block: "center", behavior: "smooth" });
      return;
    }
    void openMessageSearchResult(messageId);
  }, [openMessageSearchResult]);

  const returnToLatestMessages = useCallback(async () => {
    if (!selectedId) return;
    requestedMessageIdRef.current = null;
    historyAnchorMessageIdRef.current = null;
    historyExpandedRef.current = false;
    setHistoryAnchorMessageId(null);
    shouldStickToBottomRef.current = true;
    await loadMessages(selectedId, { latest: true });
  }, [loadMessages, selectedId]);

  const loadEarlierMessages = useCallback(async () => {
    if (!selectedId || historyLoading || historyAnchorMessageIdRef.current) return;
    const oldestMessage = messages[0];
    const scroller = messagesScrollerRef.current;
    if (!oldestMessage || !scroller) return;
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    shouldStickToBottomRef.current = false;
    setHistoryLoading(true);
    await loadMessages(selectedId, {
      before: { createdAt: oldestMessage.created_at, id: oldestMessage.id },
      mergeOlder: true,
    });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const currentScroller = messagesScrollerRef.current;
        if (!currentScroller) return;
        currentScroller.scrollTop = previousTop + (currentScroller.scrollHeight - previousHeight);
      });
    });
    setHistoryLoading(false);
  }, [historyLoading, loadMessages, messages, selectedId]);

  const uploadDraftAttachment = useCallback(async (draft: DraftAttachment) => {
    const { file, conversationId } = draft;
    let stagedAttachmentId: string | null = null;
    const discardIfCancelled = async () => {
      if (!cancelledDraftIdsRef.current.has(draft.localId)) return false;
      if (stagedAttachmentId) {
        await fetch(
          `/api/conversations/${conversationId}/attachments?attachment_id=${encodeURIComponent(stagedAttachmentId)}`,
          { method: "DELETE", keepalive: true }
        ).catch(() => null);
      }
      cancelledDraftIdsRef.current.delete(draft.localId);
      return true;
    };
    try {
      if (await discardIfCancelled()) return;
      if (!file) throw new Error("Choose this file again to retry the upload.");
      if (!isConversationAttachmentMime(draft.mimeType)) {
        throw new Error("Choose a JPEG, PNG, WebP, PDF or supported voice-note file.");
      }
      if (file.size <= 0 || file.size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
        throw new Error("Attachments must be no larger than 25 MB.");
      }

      if (file.size <= CONVERSATION_DIRECT_UPLOAD_MAX_BYTES) {
        stagedAttachmentId = crypto.randomUUID();
        const activeAttachmentId = stagedAttachmentId;
        commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
          ? { ...item, stagedAttachmentId: activeAttachmentId }
          : item), conversationId);
        const form = new FormData();
        form.set("attachment_id", activeAttachmentId);
        form.set("file", file, file.name);
        if (draft.voiceNoteDurationMs != null) {
          form.set("voice_note", "true");
          form.set("duration_ms", String(draft.voiceNoteDurationMs));
        }
        let completedAttachment: ConversationAttachment | null = null;
        const upload = fetch(`/api/conversations/${conversationId}/attachments`, {
          method: "POST",
          body: form,
        }).then(async (response) => {
          const body = await response.json().catch(() => ({})) as {
            attachment?: ConversationAttachment;
            error?: string;
            retryable?: boolean;
          };
          if (response.ok && body.attachment) {
            completedAttachment = body.attachment;
            return { error: null };
          }
          if (response.status === 409 && body.retryable) return { error: null };
          return { error: { message: body.error ?? "Could not upload attachment" } };
        });
        const readyAttachment = await awaitConversationUploadReady({
          upload,
          probe: () => completedAttachment
            ? Promise.resolve({ status: "ready", value: completedAttachment })
            : probeConversationAttachment(conversationId, activeAttachmentId),
        });
        if (await discardIfCancelled()) return;
        commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
          ? {
              ...item,
              status: "ready",
              stagedAttachmentId: null,
              attachment: readyAttachment,
              error: null,
            }
          : item), conversationId);
        return;
      }

      const urlResponse = await fetch(`/api/conversations/${conversationId}/attachments/upload-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filename: file.name,
          mime_type: draft.mimeType,
          byte_size: file.size,
          ...(draft.voiceNoteDurationMs != null ? {
            voice_note: true,
            duration_ms: draft.voiceNoteDurationMs,
          } : {}),
        }),
      });
      const urlBody = await urlResponse.json();
      if (!urlResponse.ok) throw new Error(urlBody.error ?? "Could not start upload");
      stagedAttachmentId = urlBody.attachment_id;
      if (typeof stagedAttachmentId !== "string" || !stagedAttachmentId) {
        throw new Error("Could not start upload");
      }
      const activeAttachmentId = stagedAttachmentId;
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? { ...item, stagedAttachmentId }
        : item), conversationId);
      if (await discardIfCancelled()) return;

      const supabase = createBrowserClient();
      const upload = supabase.storage
        .from(ASSET_BUCKET)
        .uploadToSignedUrl(urlBody.path, urlBody.token, file, { contentType: draft.mimeType });
      const readyAttachment = await awaitConversationUploadReady({
        upload,
        probe: () => probeConversationAttachment(conversationId, activeAttachmentId),
      });
      if (await discardIfCancelled()) return;
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "ready",
            stagedAttachmentId: null,
            attachment: readyAttachment,
            error: null,
          }
        : item), conversationId);
    } catch (reason) {
      if (await discardIfCancelled()) return;
      const canRecover = stagedAttachmentId && isRecoverableConversationUploadError(reason);
      if (stagedAttachmentId && !canRecover) {
        await fetch(
          `/api/conversations/${conversationId}/attachments?attachment_id=${encodeURIComponent(stagedAttachmentId)}`,
          { method: "DELETE" }
        ).catch(() => null);
      }
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "error",
            stagedAttachmentId: canRecover ? stagedAttachmentId : null,
            attachment: null,
            error: reason instanceof Error ? reason.message : "Upload failed",
          }
        : item), conversationId);
    }
  }, [commitDraftAttachments]);

  const recoverStagedAttachment = useCallback(async (draft: DraftAttachment) => {
    if (!draft.stagedAttachmentId) return;
    const { conversationId, stagedAttachmentId } = draft;
    try {
      const attachment = await awaitConversationUploadReady({
        upload: Promise.resolve({ error: null }),
        probe: () => probeConversationAttachment(conversationId, stagedAttachmentId),
        initialProbeDelayMs: 0,
        maxProbes: 5,
      });
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "ready",
            stagedAttachmentId: null,
            attachment,
            previewUrl: item.previewUrl ?? (attachment.mime_type.startsWith("image/") ? attachment.url : null),
            error: null,
          }
        : item), conversationId);
    } catch (reason) {
      const canRecover = isRecoverableConversationUploadError(reason);
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "error",
            stagedAttachmentId: canRecover ? stagedAttachmentId : null,
            error: canRecover
              ? reason instanceof Error ? reason.message : "Could not finish the upload. Try again."
              : "The interrupted upload could not be recovered. Choose the file again.",
          }
        : item), conversationId);
    }
  }, [commitDraftAttachments]);

  const retryDraftAttachment = useCallback((localId: string) => {
    const failed = draftAttachmentsRef.current.find((item) => item.localId === localId && item.status === "error");
    if (!failed) return;
    const canRecover = Boolean(failed.stagedAttachmentId);
    const retrying: DraftAttachment = {
      ...failed,
      status: "uploading",
      stagedAttachmentId: canRecover ? failed.stagedAttachmentId : null,
      attachment: null,
      error: null,
    };
    setError(null);
    commitDraftAttachments(
      (current) => current.map((item) => item.localId === localId ? retrying : item),
      failed.conversationId
    );
    if (canRecover) void recoverStagedAttachment(retrying);
    else void uploadDraftAttachment(retrying);
  }, [commitDraftAttachments, recoverStagedAttachment, uploadDraftAttachment]);

  const loadServerDraftAttachments = useCallback(async (conversationId: string) => {
    const requestNumber = (draftAttachmentLoadSequenceRef.current.get(conversationId) ?? 0) + 1;
    draftAttachmentLoadSequenceRef.current.set(conversationId, requestNumber);
    try {
      const response = await fetch(`/api/conversations/${conversationId}/attachments?drafts=1`, {
        cache: "no-store",
      });
      const body = await response.json() as { attachments?: ConversationAttachment[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not restore attachment drafts");
      if (draftAttachmentLoadSequenceRef.current.get(conversationId) !== requestNumber) return;
      const queuedAttachmentIds = new Set(
        outboxRef.current
          .filter((entry) => entry.conversationId === conversationId)
          .flatMap((entry) => entry.attachmentIds)
      );
      const current = draftAttachmentsByConversationRef.current.get(conversationId) ?? [];
      const knownIds = new Set(current.flatMap((item) => [
        item.attachment?.id,
        item.stagedAttachmentId,
      ].filter((id): id is string => Boolean(id))));
      const restored = (body.attachments ?? []).flatMap((attachment): DraftAttachment[] => {
        if (queuedAttachmentIds.has(attachment.id) || knownIds.has(attachment.id)) return [];
        return [{
          localId: `server:${attachment.id}`,
          conversationId,
          file: null,
          filename: attachment.filename,
          mimeType: attachment.mime_type,
          byteSize: attachment.byte_size,
          previewUrl: attachment.status === "ready" && attachment.mime_type.startsWith("image/")
            ? attachment.url
            : null,
          status: attachment.status === "ready" ? "ready" : "uploading",
          stagedAttachmentId: attachment.status === "ready" ? null : attachment.id,
          attachment: attachment.status === "ready" ? attachment : null,
          error: null,
          voiceNoteDurationMs: isVoiceNoteMetadata(attachment.metadata)
            ? attachment.metadata.duration_ms
            : null,
        }];
      });
      if (restored.length === 0) return;
      commitDraftAttachments((drafts) => [...drafts, ...restored], conversationId);
      for (const draft of restored) {
        if (draft.status === "uploading") void recoverStagedAttachment(draft);
      }
    } catch (reason) {
      if (
        selectedIdRef.current === conversationId
        && draftAttachmentLoadSequenceRef.current.get(conversationId) === requestNumber
      ) {
        setError(reason instanceof Error ? reason.message : "Could not restore attachment drafts");
      }
    }
  }, [commitDraftAttachments, recoverStagedAttachment]);

  useEffect(() => {
    if (selectedId) void loadServerDraftAttachments(selectedId);
  }, [loadServerDraftAttachments, selectedId]);

  const uploadSelectedFiles = useCallback(async (selectedFiles: FileList | null) => {
    if (!selectedId || !selectedFiles?.length) return;
    const conversationId = selectedId;
    const availableSlots = MAX_CONVERSATION_ATTACHMENTS - draftAttachmentsRef.current.length;
    if (availableSlots <= 0) {
      setError(`Attach no more than ${MAX_CONVERSATION_ATTACHMENTS} files to one message.`);
      return;
    }
    const files = Array.from(selectedFiles).slice(0, availableSlots);
    if (selectedFiles.length > availableSlots) {
      setError(`Only the first ${availableSlots} file${availableSlots === 1 ? "" : "s"} were added.`);
    } else {
      setError(null);
    }

    const drafts = files.map((file, index): DraftAttachment => {
      const mimeType = file.type || (/\.pdf$/i.test(file.name) ? "application/pdf" : "");
      return {
        localId: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}`,
        conversationId,
        file,
        filename: file.name,
        mimeType,
        byteSize: file.size,
        previewUrl: mimeType.startsWith("image/") ? URL.createObjectURL(file) : null,
        status: "preparing",
        stagedAttachmentId: null,
        attachment: null,
        error: null,
        voiceNoteDurationMs: null,
      };
    });
    commitDraftAttachments((current) => [...current, ...drafts], conversationId);
    setAttachmentMenuOpen(false);
    const uploads: Promise<void>[] = [];
    for (const draft of drafts) {
      if (!draft.file) continue;
      const preparedFile = await prepareConversationImageForUpload(draft.file);
      const preparedDraft: DraftAttachment = {
        ...draft,
        file: preparedFile,
        byteSize: preparedFile.size,
        status: "uploading",
      };
      commitDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? { ...item, file: preparedFile, byteSize: preparedFile.size, status: "uploading" }
        : item), conversationId);
      uploads.push(uploadDraftAttachment(preparedDraft));
    }
    await Promise.all(uploads);
  }, [commitDraftAttachments, selectedId, uploadDraftAttachment]);

  const addRecordedVoiceNote = useCallback((conversationId: string, file: File, durationMs: number) => {
    if ((draftAttachmentsByConversationRef.current.get(conversationId)?.length ?? 0) >= MAX_CONVERSATION_ATTACHMENTS) {
      setError(`Attach no more than ${MAX_CONVERSATION_ATTACHMENTS} files to one message.`);
      return;
    }
    const draftAttachment: DraftAttachment = {
      localId: `voice-note:${crypto.randomUUID()}`,
      conversationId,
      file,
      filename: file.name,
      mimeType: file.type,
      byteSize: file.size,
      previewUrl: null,
      status: "uploading",
      stagedAttachmentId: null,
      attachment: null,
      error: null,
      voiceNoteDurationMs: durationMs,
    };
    setError(null);
    commitDraftAttachments((current) => [...current, draftAttachment], conversationId);
    void uploadDraftAttachment(draftAttachment);
  }, [commitDraftAttachments, uploadDraftAttachment]);

  const sendMessage = useCallback(async (
    body: string,
    source: "text" | "voice" = "text",
    targetAgent?: AgentSlug,
    attachmentIds: string[] = []
  ) => {
    if (!selectedId || (!body.trim() && attachmentIds.length === 0)) return;
    historyAnchorMessageIdRef.current = null;
    setHistoryAnchorMessageId(null);
    shouldStickToBottomRef.current = true;
    setSending(true);
    if (source === "voice") setCallState("thinking");
    try {
      const response = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          body,
          source,
          target_agent_slugs: targetAgent ? [targetAgent] : undefined,
          attachment_ids: attachmentIds,
          client_message_id: crypto.randomUUID(),
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send message");
      const queueWarning = result.queue_error
        ? `Message saved, but ${targetAgent ? targetAgent[0].toUpperCase() + targetAgent.slice(1) : "the agent"} could not be notified. Please try again shortly.`
        : null;
      setInterim("");
      if (attachmentIds.length > 0) {
        commitDraftAttachments((current) => {
          current.forEach((item) => item.previewUrl?.startsWith("blob:") && URL.revokeObjectURL(item.previewUrl));
          return [];
        }, selectedId);
      }
      shouldStickToBottomRef.current = true;
      await loadMessages(selectedId);
      await loadConversations();
      if (queueWarning) setError(queueWarning);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not send message");
      if (source === "voice") setCallState("listening");
    } finally {
      setSending(false);
    }
  }, [commitDraftAttachments, selectedId, loadMessages, loadConversations]);

  const queueDraftMessage = useCallback(async (
    conversationId: string,
    body: string,
    attachments: ConversationAttachment[],
    replyTarget: ConversationMessage | null
  ) => {
    const ownerProfileId = currentUserIdRef.current;
    if (!ownerProfileId) {
      setError("The signed-in profile is still loading. Please try again.");
      return;
    }
    if (selectedIdRef.current === conversationId) {
      historyAnchorMessageIdRef.current = null;
      setHistoryAnchorMessageId(null);
      shouldStickToBottomRef.current = true;
    }
    if (!body.trim() && attachments.length === 0) return;
    if (body.trim().length > 20000) {
      setError("Message is too long.");
      return;
    }
    const voiceNote = attachments.length === 1 && isVoiceNoteMetadata(attachments[0].metadata)
      ? attachments[0]
      : null;
    const messageBody = body.trim() || (voiceNote
      ? `Voice note · ${voiceNoteDurationLabel(voiceNote.metadata.duration_ms as number)}`
      : `Shared ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`);
    const createdAtMs = Math.max(Date.now(), lastOutboxCreatedAtMsRef.current + 1);
    lastOutboxCreatedAtMsRef.current = createdAtMs;
    const entry: PendingConversationMessage = {
      clientMessageId: crypto.randomUUID(),
      ownerProfileId,
      conversationId,
      body: messageBody,
      source: voiceNote ? "voice_note" : "text",
      replyToId: replyTarget?.id ?? null,
      attachmentIds: attachments.map((attachment) => attachment.id),
      attachments,
      createdAt: new Date(createdAtMs).toISOString(),
      status: "queued",
      error: null,
      retryable: true,
    };

    setSending(true);
    setError(null);
    try {
      // Persist before clearing the composer. A screen close between these
      // operations can leave a duplicate draft, but can never lose a message.
      await savePendingConversationMessage(entry);
      const next = mergePendingConversationMessages(outboxRef.current, [entry]);
      outboxRef.current = next;
      setOutbox(next);
      clearDraft(conversationId, body);
      setReplyingTo((current) => current?.id === replyTarget?.id ? null : current);
      const sentAttachmentIds = new Set(entry.attachmentIds);
      commitDraftAttachments((current) => {
        current.forEach((item) => {
          if (
            item.attachment
            && sentAttachmentIds.has(item.attachment.id)
            && item.previewUrl?.startsWith("blob:")
          ) URL.revokeObjectURL(item.previewUrl);
        });
        return current.filter((item) => !item.attachment || !sentAttachmentIds.has(item.attachment.id));
      }, conversationId);
      setAttachmentMenuOpen(false);
      shouldStickToBottomRef.current = true;
      void flushOutbox();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This message could not be saved for sending.");
    } finally {
      setSending(false);
    }
  }, [clearDraft, commitDraftAttachments, flushOutbox]);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(event));
  }, []);

  const interruptRealtimePlayback = useCallback((detectedAt = performance.now()) => {
    const generatingResponseId = activeResponseIdRef.current;
    const progressCue = activeRealtimeProgressCueRef.current;
    // `response.done` can arrive while WebRTC still has buffered audio. Keep a
    // separate output-audio id so barge-in clears that audible tail instead of
    // treating generation completion as playback completion.
    const responseId = activeOutputAudioResponseIdRef.current ?? progressCue?.responseId ?? generatingResponseId ?? null;
    const toolCallId = responseId
      ? realtimeResponseToolCallIdsRef.current.get(responseId)
        ?? realtimeProgressResponseToolCallIdsRef.current.get(responseId)
        ?? progressCue?.toolCallId
        ?? null
      : null;
    const outputWasAudible = Boolean(responseId && realtimeAudibleResponseIdsRef.current.has(responseId));
    if (generatingResponseId && generatingResponseId !== responseId) {
      cancelledResponseIdsRef.current.add(generatingResponseId);
      const generatingToolCallId = realtimeResponseToolCallIdsRef.current.get(generatingResponseId);
      const generatingTiming = generatingToolCallId ? realtimeTurnTimingsRef.current.get(generatingToolCallId) : null;
      if (generatingTiming && generatingTiming.outcome === "pending") generatingTiming.outcome = "cancelled";
    }
    if (responseId) {
      cancelledResponseIdsRef.current.add(responseId);
      const timing = toolCallId ? realtimeTurnTimingsRef.current.get(toolCallId) : null;
      if (timing && timing.outcome === "pending") timing.outcome = "cancelled";
    }
    if (generatingResponseId) activeResponseIdRef.current = null;
    if (progressCue?.responseId) {
      cancelledResponseIdsRef.current.add(progressCue.responseId);
      if (!progressCue.done) {
        sendRealtimeEvent({ type: "response.cancel", response_id: progressCue.responseId });
      }
    }
    activeRealtimeProgressCueRef.current = null;
    // A VAD speech-start is only evidence that playback should stop. It is
    // not yet a completed replacement request: road noise, echo and a throat
    // clear can all produce this event. Keep the authoritative OpenClaw
    // consult alive until a newer completed tool call supersedes it.
    // Cancel only a response that is still generating. If `response.done`
    // already arrived, the remaining work is buffered playback and clearing
    // the output buffer is sufficient (and avoids a harmless provider error).
    if (generatingResponseId) sendRealtimeEvent({ type: "response.cancel", response_id: generatingResponseId });
    if (responseId || progressCue?.responseId) {
      sendRealtimeEvent({ type: "output_audio_buffer.clear" });
    }
    if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
    const mutedAt = performance.now();
    if (responseId && outputWasAudible) {
      pendingRealtimeInterruptionsRef.current.set(responseId, { detectedAt, mutedAt, toolCallId });
      const timing = toolCallId ? realtimeTurnTimingsRef.current.get(toolCallId) : null;
      if (timing) timing.interruptionToMuteMs = performanceDuration(detectedAt, mutedAt) ?? null;
    }
    setCallState("interrupted");
  }, [sendRealtimeEvent]);

  const cancelActiveRealtimeConsult = useCallback(() => {
    const consult = activeRealtimeConsultRef.current;
    if (consult) {
      cancelledToolCallIdsRef.current.add(consult.toolCallId);
      const timing = realtimeTurnTimingsRef.current.get(consult.toolCallId);
      if (timing && timing.outcome === "pending") timing.outcome = "cancelled";
      consult.abortController.abort();
      activeRealtimeConsultRef.current = null;
      if (selectedId && callAgent?.agent_slug) {
        void fetch(`/api/conversations/${selectedId}/realtime/consult`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tool_call_id: consult.toolCallId, agent_slug: callAgent.agent_slug }),
        }).catch(() => null);
      }
    }
  }, [callAgent, selectedId]);

  const cancelActiveRealtimeTurn = useCallback(() => {
    interruptRealtimePlayback();
    cancelActiveRealtimeConsult();
  }, [cancelActiveRealtimeConsult, interruptRealtimePlayback]);

  const flushPendingCallEnds = useCallback(async (requestedCallId?: string) => {
    const ownerProfileId = currentUserIdRef.current;
    if (!ownerProfileId || !navigator.onLine) return false;
    let requestedCallSaved = requestedCallId == null;
    let refreshedConversationId: string | null = null;
    const pending = listPendingConversationCallEnds(ownerProfileId);
    for (const entry of pending) {
      try {
        const response = await fetch(`/api/conversations/${entry.conversationId}/calls`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ call_id: entry.callId, voice_metrics: entry.voiceMetrics }),
        });
        if (!response.ok) continue;
        removePendingConversationCallEnd(ownerProfileId, entry.callId);
        if (entry.callId === requestedCallId) requestedCallSaved = true;
        if (selectedIdRef.current === entry.conversationId) refreshedConversationId = entry.conversationId;
      } catch {
        // The durable device entry remains queued for the next online event.
      }
    }
    if (refreshedConversationId) await loadMessages(refreshedConversationId);
    return requestedCallSaved;
  }, [loadMessages]);

  const persistCallEnd = useCallback(async (
    conversationId: string,
    callId: string,
    voiceMetrics: unknown
  ) => {
    const ownerProfileId = currentUserIdRef.current;
    if (!ownerProfileId) return false;
    const pendingEnd: PendingConversationCallEnd = {
      ownerProfileId,
      conversationId,
      callId,
      createdAt: new Date().toISOString(),
      voiceMetrics,
    };
    try {
      savePendingConversationCallEnd(pendingEnd);
      return await flushPendingCallEnds(callId);
    } catch {
      try {
        const response = await fetch(`/api/conversations/${conversationId}/calls`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ call_id: callId, voice_metrics: voiceMetrics }),
        });
        if (!response.ok) return false;
        if (selectedIdRef.current === conversationId) await loadMessages(conversationId);
        return true;
      } catch {
        return false;
      }
    }
  }, [flushPendingCallEnds, loadMessages]);

  useEffect(() => {
    if (!currentUserId) return;
    const flush = () => { void flushPendingCallEnds(); };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [currentUserId, flushPendingCallEnds]);

  const endCall = useCallback(async (options?: { preserveStartIntent?: boolean }) => {
    postNativeVoiceBridgeEvent({ type: "call.end" });
    callActiveRef.current = false;
    realtimeActiveRef.current = false;
    realtimeConnectionGenerationRef.current += 1;
    if (realtimeReconnectTimerRef.current != null) {
      window.clearTimeout(realtimeReconnectTimerRef.current);
      realtimeReconnectTimerRef.current = null;
    }
    realtimeReconnectAttemptsRef.current = 0;
    realtimeReconnectInFlightRef.current = false;
    cancelActiveRealtimeTurn();
    const voiceMetrics = realtimeVoiceMetrics(realtimeTurnTimingsRef.current);
    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerConnectionRef.current?.close();
    peerConnectionRef.current = null;
    microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
    microphoneStreamRef.current = null;
    if (remoteAudioRef.current) {
      remoteAudioRef.current.pause();
      remoteAudioRef.current.srcObject = null;
      remoteAudioRef.current = null;
    }
    recognitionPausedRef.current = false;
    recognitionRef.current?.abort();
    recognitionRef.current = null;
    window.speechSynthesis?.cancel();
    const activeCallId = callIdRef.current;
    const activeConversationId = callConversationIdRef.current ?? selectedId;
    callIdRef.current = null;
    let callRecordSaved = true;
    if (activeConversationId && activeCallId) {
      callRecordSaved = await persistCallEnd(activeConversationId, activeCallId, voiceMetrics);
      if (!callRecordSaved) {
        setError("The call ended. Its timeline record is queued on this device and will retry when the connection recovers.");
      }
    }
    if (!options?.preserveStartIntent) {
      clientCallIdRef.current = null;
      callConversationIdRef.current = null;
    }
    setCallId(null);
    setCallOpening(false);
    setCallError(null);
    setInterim("");
    activeResponseIdRef.current = null;
    activeOutputAudioResponseIdRef.current = null;
    activeRealtimeConsultRef.current = null;
    cancelledResponseIdsRef.current.clear();
    cancelledToolCallIdsRef.current.clear();
    handledToolCallIdsRef.current.clear();
    lastRealtimeSpeechStoppedAtRef.current = null;
    realtimeTurnSequenceRef.current = 0;
    realtimeTurnTimingsRef.current.clear();
    realtimeResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseCueIdsRef.current.clear();
    realtimeAudibleResponseIdsRef.current.clear();
    pendingRealtimeInterruptionsRef.current.clear();
    activeRealtimeProgressCueRef.current = null;
    pendingSpokenToolCallIdRef.current = null;
    inputTranscriptByItemRef.current.clear();
    callTranscriptStickRef.current = true;
    setCallTranscriptExpanded(false);
    setCallTranscript([]);
    return callRecordSaved;
  }, [cancelActiveRealtimeTurn, persistCallEnd, selectedId]);

  useEffect(() => {
    const handleNativeVoiceCommand = (event: Event) => {
      const detail = (event as CustomEvent<{ type?: string; message?: string; muted?: boolean }>).detail;
      if (detail?.type === "end-requested" && callActiveRef.current && callIdRef.current) void endCall();
      if (detail?.type === "native-audio-error" && callIdRef.current) {
        setError(`The iPhone call audio session could not start. ${detail.message ?? "Please try again."}`);
        if (callActiveRef.current) void endCall();
      }
      if (detail?.type === "mute-requested" && typeof detail.muted === "boolean" && callActiveRef.current) {
        mutedRef.current = detail.muted;
        setMuted(detail.muted);
        microphoneStreamRef.current?.getAudioTracks().forEach((track) => {
          track.enabled = !detail.muted;
        });
        if (!realtimeActiveRef.current) {
          if (detail.muted) recognitionRef.current?.stop();
          else {
            try { recognitionRef.current?.start(); } catch { /* already active */ }
          }
        }
      }
      if (detail?.type === "mute-sync-error") {
        setNotice(`The iPhone lock-screen mute control could not update. ${detail.message ?? "The in-app microphone control is still active."}`);
      }
    };
    window.addEventListener("reslu-native-voice", handleNativeVoiceCommand);
    return () => window.removeEventListener("reslu-native-voice", handleNativeVoiceCommand);
  }, [endCall]);

  const handleVoiceText = useCallback((text: string) => {
    const command = text.trim().toLowerCase().replace(/[.!?]+$/, "");
    if (command === "stop" || command === "pause") {
      window.speechSynthesis?.cancel();
      setCallState("interrupted");
      window.setTimeout(() => callActiveRef.current && setCallState("listening"), 500);
      return;
    }
    if (command === "end the call" || command === "hang up") { void endCall(); return; }
    if (command === "repeat" && lastSpoken) { speak(lastSpoken); return; }
    if (text.trim() && callAgent?.agent_slug) void sendMessage(text.trim(), "voice", callAgent.agent_slug);
  }, [callAgent, endCall, lastSpoken, sendMessage, speak]);

  const beginRealtimeTurnTiming = useCallback((toolCallId: string) => {
    const existing = realtimeTurnTimingsRef.current.get(toolCallId);
    if (existing) return existing;
    const speechStoppedAt = lastRealtimeSpeechStoppedAtRef.current;
    const progressCue = activeRealtimeProgressCueRef.current;
    const matchingCue = progressCue && progressCue.speechStoppedAt === speechStoppedAt ? progressCue : null;
    if (matchingCue) matchingCue.toolCallId = toolCallId;
    const timing: RealtimeTurnTiming = {
      turn: ++realtimeTurnSequenceRef.current,
      outcome: "pending",
      speechStoppedAt,
      toolCallAt: performance.now(),
      progressRequestedAt: matchingCue?.requestedAt ?? null,
      progressAudioAt: matchingCue?.audioAt ?? null,
      consultStartedAt: null,
      consultAcceptedAt: null,
      answerReadyAt: null,
      responseRequestedAt: null,
      firstAudioAt: null,
      queueWaitMs: null,
      agentProcessingMs: null,
      backendTotalMs: null,
      interruptionToMuteMs: null,
      interruptionToBufferClearedMs: null,
    };
    if (matchingCue?.responseId) {
      realtimeProgressResponseToolCallIdsRef.current.set(matchingCue.responseId, toolCallId);
    }
    lastRealtimeSpeechStoppedAtRef.current = null;
    realtimeTurnTimingsRef.current.set(toolCallId, timing);
    return timing;
  }, []);

  const stopRealtimeProgressCue = useCallback(() => {
    const cue = activeRealtimeProgressCueRef.current;
    if (!cue?.responseId) {
      activeRealtimeProgressCueRef.current = null;
      return;
    }
    if (!cue.done) sendRealtimeEvent({ type: "response.cancel", response_id: cue.responseId });
    sendRealtimeEvent({ type: "output_audio_buffer.clear" });
    activeRealtimeProgressCueRef.current = null;
  }, [sendRealtimeEvent]);

  const runRealtimeConsult = useCallback(async (
    toolCallId: string,
    responseId: string | null,
    argumentsJson: string,
    deferInvalidArguments = false,
  ) => {
    if (!selectedId || !callAgent?.agent_slug || !callIdRef.current || handledToolCallIdsRef.current.has(toolCallId)) return;
    const parsedArguments = parseRealtimeConsultArguments(argumentsJson);
    if (!parsedArguments && deferInvalidArguments) return;
    handledToolCallIdsRef.current.add(toolCallId);
    const timing = beginRealtimeTurnTiming(toolCallId);
    if (!parsedArguments) {
      timing.outcome = "failed";
      setCallError("I couldn’t understand that turn. Please say it again.");
      setCallState("listening");
      return;
    }
    const { query } = parsedArguments;

    // A completed newer utterance is the point at which the prior consult is
    // genuinely superseded. Abort its local poll and cancel that exact job;
    // the POST below also atomically supersedes any unfinished agent work.
    if (activeRealtimeConsultRef.current) cancelActiveRealtimeConsult();
    const abortController = new AbortController();
    activeRealtimeConsultRef.current = {
      toolCallId,
      responseId,
      abortController,
    };
    setInterim(query);
    setCallState("thinking");
    try {
      timing.consultStartedAt = performance.now();
      const start = await fetch(`/api/conversations/${selectedId}/realtime/consult`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: abortController.signal,
        body: JSON.stringify({
          query,
          agent_slug: callAgent.agent_slug,
          call_id: callIdRef.current,
          tool_call_id: toolCallId,
          response_id: responseId,
        }),
      });
      const startBody = await start.json() as { error?: string };
      timing.consultAcceptedAt = performance.now();
      if (!start.ok) throw new Error(startBody.error ?? "Could not consult the RESLU agent");

      while (!abortController.signal.aborted && callActiveRef.current) {
        const statusResponse = await fetch(
          `/api/conversations/${selectedId}/realtime/consult?tool_call_id=${encodeURIComponent(toolCallId)}&agent_slug=${callAgent.agent_slug}`,
          { cache: "no-store", signal: abortController.signal }
        );
        const statusBody = await statusResponse.json() as RealtimeConsultStatusResponse;
        if (!statusResponse.ok) throw new Error(statusBody.error ?? "Could not read the RESLU agent response");
        if (statusBody.latency) {
          timing.queueWaitMs = statusBody.latency.queue_wait_ms ?? timing.queueWaitMs;
          timing.agentProcessingMs = statusBody.latency.agent_processing_ms ?? timing.agentProcessingMs;
          timing.backendTotalMs = statusBody.latency.backend_total_ms ?? timing.backendTotalMs;
        }
        if (statusBody.status === "done" && typeof statusBody.answer === "string") {
          if (cancelledToolCallIdsRef.current.has(toolCallId) || abortController.signal.aborted) return;
          timing.answerReadyAt = performance.now();
          activeRealtimeConsultRef.current = null;
          setLastSpoken(statusBody.answer);
          setInterim("");
          void loadMessages(selectedId);
          stopRealtimeProgressCue();
          const progressResponseId = activeResponseIdRef.current;
          if (progressResponseId) {
            cancelledResponseIdsRef.current.add(progressResponseId);
            sendRealtimeEvent({ type: "response.cancel" });
            sendRealtimeEvent({ type: "output_audio_buffer.clear" });
            activeResponseIdRef.current = null;
            if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
          }
          sendRealtimeEvent({
            type: "conversation.item.create",
            item: {
              type: "function_call_output",
              call_id: toolCallId,
              output: JSON.stringify({
                answer: statusBody.answer,
                instruction: "Speak this existing RESLU agent answer faithfully. Add no new facts or actions.",
              }),
            },
          });
          pendingSpokenToolCallIdRef.current = toolCallId;
          timing.responseRequestedAt = performance.now();
          sendRealtimeEvent({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              tool_choice: "none",
              instructions: "Speak the consult_reslu_agent answer faithfully and naturally. Do not add, infer or perform anything.",
            },
          });
          return;
        }
        if (statusBody.status === "cancelled") {
          timing.outcome = "cancelled";
          activeRealtimeConsultRef.current = null;
          stopRealtimeProgressCue();
          setCallState("listening");
          return;
        }
        if (statusBody.status === "failed") throw new Error(statusBody.error ?? "The RESLU agent could not answer");
        await new Promise<void>((resolve, reject) => {
          const timer = window.setTimeout(resolve, 650);
          abortController.signal.addEventListener("abort", () => {
            window.clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          }, { once: true });
        });
      }
    } catch (reason) {
      if (reason instanceof DOMException && reason.name === "AbortError") return;
      if (cancelledToolCallIdsRef.current.has(toolCallId)) return;
      timing.outcome = "failed";
      activeRealtimeConsultRef.current = null;
      stopRealtimeProgressCue();
      setCallError(reason instanceof Error ? reason.message : "The RESLU agent could not answer");
      setCallState("listening");
    }
  }, [beginRealtimeTurnTiming, callAgent, cancelActiveRealtimeConsult, loadMessages, selectedId, sendRealtimeEvent, stopRealtimeProgressCue]);

  const runRealtimeTask = useCallback(async (
    toolCallId: string,
    responseId: string | null,
    argumentsJson: string,
    deferInvalidArguments = false,
  ) => {
    if (!selectedId || !callAgent?.agent_slug || !callIdRef.current || handledToolCallIdsRef.current.has(toolCallId)) return;
    const parsedArguments = parseRealtimeTaskArguments(argumentsJson);
    if (!parsedArguments && deferInvalidArguments) return;
    handledToolCallIdsRef.current.add(toolCallId);
    const timing = beginRealtimeTurnTiming(toolCallId);
    if (!parsedArguments) {
      timing.outcome = "failed";
      setCallError("I couldn’t create that task. Please state the outcome you want.");
      setCallState("listening");
      return;
    }
    const { title, objective, modelTier } = parsedArguments;
    if (activeRealtimeConsultRef.current) cancelActiveRealtimeConsult();
    setCallState("thinking");
    try {
      const response = await fetch(`/api/conversations/${selectedId}/realtime/task`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          objective,
          model_tier: modelTier,
          agent_slug: callAgent.agent_slug,
          call_id: callIdRef.current,
          tool_call_id: toolCallId,
          response_id: responseId,
        }),
      });
      const body = await response.json() as { acknowledgement?: string; task?: AgentTask; error?: string };
      if (!response.ok || !body.task || !body.acknowledgement) {
        throw new Error(body.error ?? "Could not start the background task");
      }
      timing.answerReadyAt = performance.now();
      void loadMessages(selectedId);
      void loadAgentTasks(selectedId);
      upsertCallTranscript({
        id: `system-task-${body.task.id}`,
        speaker: "system",
        text: `${body.task.title} · working in background`,
        final: true,
      });
      sendRealtimeEvent({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: JSON.stringify({
            task_id: body.task.id,
            status: body.task.status,
            answer: body.acknowledgement,
          }),
        },
      });
      stopRealtimeProgressCue();
      pendingSpokenToolCallIdRef.current = toolCallId;
      timing.responseRequestedAt = performance.now();
      sendRealtimeEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          tool_choice: "none",
          instructions: "Speak only the start_reslu_task answer. Add no facts, promises or actions.",
        },
      });
    } catch (reason) {
      timing.outcome = "failed";
      stopRealtimeProgressCue();
      setCallError(reason instanceof Error ? reason.message : "Could not start the background task");
      setCallState("listening");
    }
  }, [beginRealtimeTurnTiming, callAgent, cancelActiveRealtimeConsult, loadAgentTasks, loadMessages, selectedId, sendRealtimeEvent, stopRealtimeProgressCue, upsertCallTranscript]);

  const runRealtimeMeetingMode = useCallback((toolCallId: string) => {
    if (!selectedId || callAgent?.agent_slug !== "aria" || handledToolCallIdsRef.current.has(toolCallId)) return;
    handledToolCallIdsRef.current.add(toolCallId);
    const sourceCallId = callIdRef.current;
    upsertCallTranscript({
      id: `system-meeting-${toolCallId}`,
      speaker: "system",
      text: "Switching to silent Meeting Mode",
      final: true,
    });
    setMeetingSourceCallId(sourceCallId);
    setMeetingMinutesId(null);
    void endCall().then(() => setMeetingModeOpen(true));
  }, [callAgent, endCall, selectedId, upsertCallTranscript]);

  const startRealtimeProgressCue = useCallback((speechStoppedAt: number) => {
    const previous = activeRealtimeProgressCueRef.current;
    if (previous?.responseId && !previous.done) {
      sendRealtimeEvent({ type: "response.cancel", response_id: previous.responseId });
      sendRealtimeEvent({ type: "output_audio_buffer.clear" });
    }
    const cueId = crypto.randomUUID();
    activeRealtimeProgressCueRef.current = {
      cueId,
      toolCallId: null,
      responseId: null,
      speechStoppedAt,
      requestedAt: performance.now(),
      audioAt: null,
      done: false,
    };
    sendRealtimeEvent(buildRealtimeProgressResponse(cueId));
  }, [sendRealtimeEvent]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "input_audio_buffer.speech_started") {
      interruptRealtimePlayback(performance.now());
      setInterim("");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      const speechStoppedAt = performance.now();
      lastRealtimeSpeechStoppedAtRef.current = speechStoppedAt;
      startRealtimeProgressCue(speechStoppedAt);
      setCallState("thinking");
      return;
    }
    if (event.type === "response.created" && event.response?.id) {
      const progressCueId = realtimeProgressCueId(event.response);
      if (progressCueId) {
        realtimeProgressResponseCueIdsRef.current.set(event.response.id, progressCueId);
        const cue = activeRealtimeProgressCueRef.current;
        if (cue?.cueId === progressCueId) {
          cue.responseId = event.response.id;
          if (cue.toolCallId) {
            realtimeProgressResponseToolCallIdsRef.current.set(event.response.id, cue.toolCallId);
          }
          if (remoteAudioRef.current) remoteAudioRef.current.muted = false;
        } else {
          cancelledResponseIdsRef.current.add(event.response.id);
          sendRealtimeEvent({ type: "response.cancel", response_id: event.response.id });
        }
        return;
      }
      activeResponseIdRef.current = event.response.id;
      const spokenToolCallId = pendingSpokenToolCallIdRef.current;
      if (spokenToolCallId) {
        realtimeResponseToolCallIdsRef.current.set(event.response.id, spokenToolCallId);
        pendingSpokenToolCallIdRef.current = null;
      }
      if (!cancelledResponseIdsRef.current.has(event.response.id) && remoteAudioRef.current) {
        remoteAudioRef.current.muted = false;
      }
      return;
    }
    // OpenAI emits output_audio_buffer.started for WebRTC and
    // response.output_audio.delta as audio generation progresses. Either is a
    // closer first-audio marker than the separate transcript stream.
    if (event.type === "output_audio_buffer.started" || event.type === "response.output_audio.delta") {
      const responseId = event.response_id ?? activeResponseIdRef.current;
      if (responseId && !cancelledResponseIdsRef.current.has(responseId)) {
        if (event.type === "output_audio_buffer.started") {
          activeOutputAudioResponseIdRef.current = responseId;
          realtimeAudibleResponseIdsRef.current.add(responseId);
        }
        const progressCueId = realtimeProgressResponseCueIdsRef.current.get(responseId);
        const activeProgressCue = activeRealtimeProgressCueRef.current;
        if (
          progressCueId &&
          activeProgressCue?.cueId === progressCueId &&
          activeProgressCue.audioAt == null
        ) {
          activeProgressCue.audioAt = performance.now();
        }
        const progressToolCallId = realtimeProgressResponseToolCallIdsRef.current.get(responseId);
        const spokenToolCallId = realtimeResponseToolCallIdsRef.current.get(responseId);
        const progressTiming = progressToolCallId ? realtimeTurnTimingsRef.current.get(progressToolCallId) : null;
        const spokenTiming = spokenToolCallId ? realtimeTurnTimingsRef.current.get(spokenToolCallId) : null;
        if (progressTiming && progressTiming.progressAudioAt == null) {
          progressTiming.progressAudioAt = performance.now();
        }
        if (spokenTiming && spokenTiming.firstAudioAt == null) {
          spokenTiming.firstAudioAt = performance.now();
          spokenTiming.outcome = "spoken";
        }
        setCallState("speaking");
      }
      return;
    }
    if (event.type === "output_audio_buffer.cleared" && event.response_id) {
      const interruption = pendingRealtimeInterruptionsRef.current.get(event.response_id);
      if (interruption) {
        const toolCallId = interruption.toolCallId
          ?? realtimeResponseToolCallIdsRef.current.get(event.response_id)
          ?? realtimeProgressResponseToolCallIdsRef.current.get(event.response_id)
          ?? null;
        const timing = toolCallId ? realtimeTurnTimingsRef.current.get(toolCallId) : null;
        if (timing) {
          timing.interruptionToMuteMs ??= performanceDuration(interruption.detectedAt, interruption.mutedAt) ?? null;
          timing.interruptionToBufferClearedMs = performanceDuration(interruption.detectedAt, performance.now()) ?? null;
        }
        pendingRealtimeInterruptionsRef.current.delete(event.response_id);
      }
      realtimeAudibleResponseIdsRef.current.delete(event.response_id);
      if (activeOutputAudioResponseIdRef.current === event.response_id) activeOutputAudioResponseIdRef.current = null;
      return;
    }
    if (event.type === "output_audio_buffer.stopped" && event.response_id) {
      realtimeAudibleResponseIdsRef.current.delete(event.response_id);
      pendingRealtimeInterruptionsRef.current.delete(event.response_id);
      if (activeOutputAudioResponseIdRef.current === event.response_id) activeOutputAudioResponseIdRef.current = null;
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.item_id && event.delta) {
      const text = `${inputTranscriptByItemRef.current.get(event.item_id) ?? ""}${event.delta}`;
      inputTranscriptByItemRef.current.set(event.item_id, text);
      upsertCallTranscript({ id: `user-${event.item_id}`, speaker: "user", text, final: false });
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.item_id && event.transcript) {
      inputTranscriptByItemRef.current.set(event.item_id, event.transcript);
      upsertCallTranscript({ id: `user-${event.item_id}`, speaker: "user", text: event.transcript, final: true });
      return;
    }
    if (event.type === "response.output_audio_transcript.delta" && event.delta) {
      const responseId = event.response_id ?? activeResponseIdRef.current;
      if (responseId && realtimeProgressResponseCueIdsRef.current.has(responseId)) return;
      setCallState("speaking");
      setInterim((current) => `${current}${event.delta}`);
      const transcriptResponseId = responseId ?? "current";
      setCallTranscript((current) => {
        const id = `agent-${transcriptResponseId}`;
        const existing = current.find((entry) => entry.id === id);
        const entry = { id, speaker: "agent" as const, text: `${existing?.text ?? ""}${event.delta}`, final: false };
        return existing ? current.map((candidate) => candidate.id === id ? entry : candidate) : [...current, entry].slice(-80);
      });
      return;
    }
    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      const responseId = event.response_id ?? activeResponseIdRef.current;
      if (responseId && realtimeProgressResponseCueIdsRef.current.has(responseId)) return;
      setLastSpoken(event.transcript);
      setInterim("");
      const transcriptResponseId = responseId ?? `done-${Date.now()}`;
      upsertCallTranscript({ id: `agent-${transcriptResponseId}`, speaker: "agent", text: event.transcript, final: true });
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.call_id && event.name === "consult_reslu_agent") {
      void runRealtimeConsult(event.call_id, event.response_id ?? activeResponseIdRef.current, event.arguments ?? "{}", true);
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.call_id && event.name === "start_reslu_task") {
      void runRealtimeTask(event.call_id, event.response_id ?? activeResponseIdRef.current, event.arguments ?? "{}", true);
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.call_id && event.name === "start_meeting_mode") {
      runRealtimeMeetingMode(event.call_id);
      return;
    }
    if (event.type === "response.done" && event.response) {
      const progressCueId = realtimeProgressCueId(event.response);
      if (progressCueId) {
        const cue = activeRealtimeProgressCueRef.current;
        if (cue?.cueId === progressCueId) cue.done = true;
        return;
      }
      const responseId = event.response.id ?? activeResponseIdRef.current;
      if (responseId && cancelledResponseIdsRef.current.has(responseId)) return;
      activeResponseIdRef.current = null;
      for (const output of event.response.output ?? []) {
        if (output.type === "function_call" && output.name === "consult_reslu_agent" && output.call_id) {
          void runRealtimeConsult(output.call_id, responseId ?? null, output.arguments ?? "{}");
        }
        if (output.type === "function_call" && output.name === "start_reslu_task" && output.call_id) {
          void runRealtimeTask(output.call_id, responseId ?? null, output.arguments ?? "{}");
        }
        if (output.type === "function_call" && output.name === "start_meeting_mode" && output.call_id) {
          runRealtimeMeetingMode(output.call_id);
        }
      }
      if (event.response.status === "completed" && !(event.response.output ?? []).some((item) => item.type === "function_call")) {
        setCallState(activeRealtimeConsultRef.current ? "thinking" : "listening");
      }
      return;
    }
    if (event.type === "error") {
      setCallError("The realtime call hit an error. Please try again.");
      setCallState("reconnecting");
    }
  }, [interruptRealtimePlayback, runRealtimeConsult, runRealtimeMeetingMode, runRealtimeTask, sendRealtimeEvent, startRealtimeProgressCue, upsertCallTranscript]);

  const createCallRecord = useCallback(async () => {
    const conversationId = callConversationIdRef.current ?? selectedId;
    if (!conversationId) throw new Error("No conversation selected");
    const clientCallId = clientCallIdRef.current ?? crypto.randomUUID();
    callConversationIdRef.current = conversationId;
    clientCallIdRef.current = clientCallId;
    const response = await fetch(`/api/conversations/${conversationId}/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        presentation: window.innerWidth < 700 ? "driving" : "office",
        client_call_id: clientCallId,
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "Could not start call");
    callIdRef.current = body.call.id;
    setCallId(body.call.id);
    return body.call.id as string;
  }, [selectedId]);

  const scheduleRealtimeReconnect = useCallback((immediate = false) => {
    if (realtimeReconnectTimerRef.current != null) return;
    const peer = peerConnectionRef.current;
    const channel = dataChannelRef.current;
    if (!shouldAttemptRealtimeReconnect({
      callActive: callActiveRef.current,
      realtimeActive: realtimeActiveRef.current,
      online: navigator.onLine,
      visible: document.visibilityState === "visible",
      backgroundCapable: nativeVoiceBridgeAvailable(),
      inFlight: realtimeReconnectInFlightRef.current,
      attempts: realtimeReconnectAttemptsRef.current,
      microphoneReady: mediaStreamCanResume(microphoneStreamRef.current),
      connectionState: peer?.connectionState ?? null,
      dataChannelState: channel?.readyState ?? null,
    })) return;
    setCallState("reconnecting");
    const delay = realtimeReconnectDelay(realtimeReconnectAttemptsRef.current, immediate);
    realtimeReconnectTimerRef.current = window.setTimeout(() => {
      realtimeReconnectTimerRef.current = null;
      void realtimeReconnectRunnerRef.current();
    }, delay);
  }, []);

  const startRealtimeCall = useCallback(async (stream: MediaStream, activeCallId: string) => {
    if (!selectedId || !callAgent?.agent_slug) throw new Error("No RESLU agent selected");
    const generation = ++realtimeConnectionGenerationRef.current;
    const peer = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    peer.ontrack = (event) => { audio.srcObject = event.streams[0]; };
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    const channel = peer.createDataChannel("oai-events");
    channel.onopen = () => {
      if (generation !== realtimeConnectionGenerationRef.current || !callActiveRef.current) return;
      postNativeVoiceBridgeEvent({ type: "call.connected" });
      realtimeReconnectAttemptsRef.current = 0;
      realtimeReconnectInFlightRef.current = false;
      setCallOpening(false);
      setCallError(null);
      setCallState(activeRealtimeConsultRef.current ? "thinking" : "listening");
    };
    channel.onmessage = (message) => {
      if (generation !== realtimeConnectionGenerationRef.current) return;
      try { handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent); } catch { /* ignore malformed provider events */ }
    };
    channel.onclose = () => {
      if (generation === realtimeConnectionGenerationRef.current) scheduleRealtimeReconnect();
    };
    peer.onconnectionstatechange = () => {
      if (generation !== realtimeConnectionGenerationRef.current) return;
      if (peer.connectionState === "failed") scheduleRealtimeReconnect(true);
      else if (peer.connectionState === "disconnected" || peer.connectionState === "closed") {
        scheduleRealtimeReconnect();
      }
    };
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(`/api/conversations/${selectedId}/realtime/session`, {
      method: "POST",
      headers: { "Content-Type": "application/sdp", "X-RESLU-Agent": callAgent.agent_slug },
      body: offer.sdp,
    });
    if (!response.ok) {
      let body: { error?: string; code?: string } = {};
      try { body = await response.json(); } catch { /* provider returned non-JSON */ }
      const error = new Error(body.error ?? "Could not start realtime voice") as Error & { code?: string };
      error.code = body.code;
      peer.close();
      audio.pause();
      audio.srcObject = null;
      throw error;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    if (generation !== realtimeConnectionGenerationRef.current || !callActiveRef.current) {
      channel.close();
      peer.close();
      audio.pause();
      audio.srcObject = null;
      return;
    }
    const previousChannel = dataChannelRef.current;
    const previousPeer = peerConnectionRef.current;
    const previousAudio = remoteAudioRef.current;
    peerConnectionRef.current = peer;
    dataChannelRef.current = channel;
    remoteAudioRef.current = audio;
    microphoneStreamRef.current = stream;
    realtimeActiveRef.current = true;
    callActiveRef.current = true;
    callIdRef.current = activeCallId;
    if (previousChannel && previousChannel !== channel) previousChannel.close();
    if (previousPeer && previousPeer !== peer) previousPeer.close();
    if (previousAudio && previousAudio !== audio) {
      previousAudio.pause();
      previousAudio.srcObject = null;
    }
    window.setTimeout(() => {
      if (
        generation === realtimeConnectionGenerationRef.current
        && callActiveRef.current
        && channel.readyState !== "open"
      ) {
        channel.close();
        peer.close();
        scheduleRealtimeReconnect(true);
      }
    }, 8000);
  }, [callAgent, handleRealtimeEvent, scheduleRealtimeReconnect, selectedId]);

  const recoverRealtimeCall = useCallback(async () => {
    const peer = peerConnectionRef.current;
    const channel = dataChannelRef.current;
    if (!shouldAttemptRealtimeReconnect({
      callActive: callActiveRef.current,
      realtimeActive: realtimeActiveRef.current,
      online: navigator.onLine,
      visible: document.visibilityState === "visible",
      backgroundCapable: nativeVoiceBridgeAvailable(),
      inFlight: realtimeReconnectInFlightRef.current,
      attempts: realtimeReconnectAttemptsRef.current,
      microphoneReady: mediaStreamCanResume(microphoneStreamRef.current),
      connectionState: peer?.connectionState ?? null,
      dataChannelState: channel?.readyState ?? null,
    })) return;
    const activeCallId = callIdRef.current;
    if (!activeCallId) return;
    realtimeReconnectInFlightRef.current = true;
    setCallState("reconnecting");
    remoteAudioRef.current?.pause();
    activeResponseIdRef.current = null;
    activeOutputAudioResponseIdRef.current = null;
    realtimeAudibleResponseIdsRef.current.clear();
    pendingRealtimeInterruptionsRef.current.clear();
    activeRealtimeProgressCueRef.current = null;
    let retry = false;
    try {
      let stream = microphoneStreamRef.current;
      if (!mediaStreamCanResume(stream)) {
        stream?.getTracks().forEach((track) => track.stop());
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getAudioTracks().forEach((track) => { track.enabled = !mutedRef.current; });
      }
      if (!stream) throw new Error("Microphone audio is unavailable");
      await startRealtimeCall(stream, activeCallId);
    } catch (reason) {
      realtimeReconnectAttemptsRef.current += 1;
      const message = reason instanceof Error ? reason.message : "Could not reconnect the call";
      if (realtimeReconnectAttemptsRef.current >= MAX_REALTIME_RECONNECT_ATTEMPTS) {
        setCallError(`Call audio is paused. ${message}`);
      } else {
        retry = true;
      }
    } finally {
      realtimeReconnectInFlightRef.current = false;
      if (retry) scheduleRealtimeReconnect();
    }
  }, [scheduleRealtimeReconnect, startRealtimeCall]);

  useEffect(() => {
    realtimeReconnectRunnerRef.current = recoverRealtimeCall;
  }, [recoverRealtimeCall]);

  useEffect(() => {
    const resumeRealtimeCall = () => {
      if (document.visibilityState === "visible" && navigator.onLine) {
        scheduleRealtimeReconnect(true);
      }
    };
    window.addEventListener("online", resumeRealtimeCall);
    window.addEventListener("focus", resumeRealtimeCall);
    document.addEventListener("visibilitychange", resumeRealtimeCall);
    return () => {
      window.removeEventListener("online", resumeRealtimeCall);
      window.removeEventListener("focus", resumeRealtimeCall);
      document.removeEventListener("visibilitychange", resumeRealtimeCall);
    };
  }, [scheduleRealtimeReconnect]);

  useEffect(() => () => {
    if (realtimeReconnectTimerRef.current != null) {
      window.clearTimeout(realtimeReconnectTimerRef.current);
      realtimeReconnectTimerRef.current = null;
    }
  }, []);

  const retryRealtimeCall = useCallback(() => {
    realtimeReconnectAttemptsRef.current = 0;
    setCallError(null);
    dataChannelRef.current?.close();
    peerConnectionRef.current?.close();
    scheduleRealtimeReconnect(true);
  }, [scheduleRealtimeReconnect]);

  const startLegacyCall = useCallback(async (existingCallId?: string) => {
    const SpeechRecognition = (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      postNativeVoiceBridgeEvent({ type: "call.end" });
      setCallOpening(false);
      setCallError("Live speech recognition is unavailable here. Open RESLU directly in Safari, not from a Home Screen icon or another app.");
      return;
    }
    try {
      // iOS Safari requires speech and audio to be activated by the original
      // tap. Start recognition before the first await, otherwise the network
      // request below can consume Safari's transient user activation.
      if ("speechSynthesis" in window) {
        const unlockAudio = new SpeechSynthesisUtterance(" ");
        unlockAudio.volume = 0;
        window.speechSynthesis.speak(unlockAudio);
      }
      callActiveRef.current = true;
      messages.forEach((message) => spokenIdsRef.current.add(message.id));
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = "en-AU";
      recognition.onspeechstart = () => {
        if (window.speechSynthesis?.speaking) {
          window.speechSynthesis.cancel();
          setCallState("interrupted");
        }
      };
      recognition.onresult = (event) => {
        let live = "";
        for (let index = event.resultIndex; index < event.results.length; index += 1) {
          const result = event.results[index];
          if (result.isFinal) {
            const transcript = result[0].transcript.trim();
            if (!transcript) continue;
            setCallTranscript((current) => current.filter((entry) => entry.id !== "legacy-user-live"));
            upsertCallTranscript({
              id: `legacy-user-${Date.now()}-${index}`,
              speaker: "user",
              text: transcript,
              final: true,
            });
            handleVoiceText(transcript);
          }
          else live += result[0].transcript;
        }
        setInterim(live);
        if (live.trim()) {
          upsertCallTranscript({ id: "legacy-user-live", speaker: "user", text: live.trim(), final: false });
        }
      };
      recognition.onerror = (event) => {
        if (!callActiveRef.current || event.error === "aborted") return;
        if (isFatalSpeechRecognitionError(event.error)) {
          callActiveRef.current = false;
          postNativeVoiceBridgeEvent({ type: "call.end" });
          setCallOpening(false);
          setCallError(speechRecognitionErrorMessage(event.error));
          recognition.abort();
          return;
        }
        setCallState("reconnecting");
      };
      recognition.onend = () => {
        if (!callActiveRef.current || mutedRef.current || recognitionPausedRef.current) return;
        try { recognition.start(); } catch { /* already restarting */ }
      };
      recognitionRef.current = recognition;
      if (!mutedRef.current) recognition.start();
      setCallState("listening");

      const activeCallId = existingCallId ?? await createCallRecord();
      if (!callActiveRef.current) {
        const conversationId = callConversationIdRef.current ?? selectedId;
        if (conversationId) await persistCallEnd(conversationId, activeCallId, []);
        callIdRef.current = null;
        clientCallIdRef.current = null;
        callConversationIdRef.current = null;
        setCallId(null);
        return;
      }
      callIdRef.current = activeCallId;
      setCallId(activeCallId);
      setCallOpening(false);
      postNativeVoiceBridgeEvent({ type: "call.connected" });
    } catch (reason) {
      callActiveRef.current = false;
      postNativeVoiceBridgeEvent({ type: "call.end" });
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setCallOpening(false);
      const message = reason instanceof Error ? reason.message : "Could not start call";
      setCallError(reason instanceof DOMException ? speechRecognitionErrorMessage(reason.name) : message);
    }
  }, [createCallRecord, handleVoiceText, messages, persistCallEnd, selectedId, upsertCallTranscript]);

  async function startCall() {
    if (!selectedId || !callAgent) return;
    if (realtimeReconnectTimerRef.current != null) {
      window.clearTimeout(realtimeReconnectTimerRef.current);
      realtimeReconnectTimerRef.current = null;
    }
    realtimeReconnectAttemptsRef.current = 0;
    realtimeReconnectInFlightRef.current = false;
    callConversationIdRef.current ??= selectedId;
    clientCallIdRef.current ??= crypto.randomUUID();
    const nativeStartEvent = {
      type: "call.start",
      callId: clientCallIdRef.current,
      conversationId: selectedId,
      agent: callAgent.display_name,
    } as const;
    lastRealtimeSpeechStoppedAtRef.current = null;
    activeResponseIdRef.current = null;
    activeOutputAudioResponseIdRef.current = null;
    realtimeTurnSequenceRef.current = 0;
    realtimeTurnTimingsRef.current.clear();
    realtimeResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseCueIdsRef.current.clear();
    realtimeAudibleResponseIdsRef.current.clear();
    pendingRealtimeInterruptionsRef.current.clear();
    activeRealtimeProgressCueRef.current = null;
    pendingSpokenToolCallIdRef.current = null;
    inputTranscriptByItemRef.current.clear();
    callTranscriptStickRef.current = true;
    setCallTranscriptExpanded(false);
    setCallTranscript([]);
    setCallError(null);
    setCallOpening(true);
    setCallState("connecting");
    callActiveRef.current = true;
    messages.forEach((message) => spokenIdsRef.current.add(message.id));

    try {
      await prepareNativeVoiceSession(nativeStartEvent);
      if (!("RTCPeerConnection" in window) || !navigator.mediaDevices?.getUserMedia) {
        await startLegacyCall();
        return;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getAudioTracks().forEach((track) => { track.enabled = !mutedRef.current; });
      microphoneStreamRef.current = stream;
      const activeCallId = await createCallRecord();
      if (!callActiveRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        microphoneStreamRef.current = null;
        const conversationId = callConversationIdRef.current ?? selectedId;
        if (conversationId) await persistCallEnd(conversationId, activeCallId, []);
        callIdRef.current = null;
        clientCallIdRef.current = null;
        callConversationIdRef.current = null;
        setCallId(null);
        return;
      }
      await startRealtimeCall(stream, activeCallId);
    } catch (reason) {
      const error = reason as Error & { code?: string };
      microphoneStreamRef.current?.getTracks().forEach((track) => track.stop());
      microphoneStreamRef.current = null;
      if (error.code === "realtime_disabled") {
        await startLegacyCall(callIdRef.current ?? undefined);
        return;
      }
      callActiveRef.current = false;
      postNativeVoiceBridgeEvent({ type: "call.end" });
      setCallOpening(false);
      setCallError(error instanceof DOMException ? speechRecognitionErrorMessage(error.name) : error.message || "Could not start call");
    }
  }

  async function retryCall() {
    const preserveStartIntent = !callIdRef.current && Boolean(clientCallIdRef.current);
    const endedCleanly = await endCall({ preserveStartIntent });
    if (!endedCleanly) return;
    await startCall();
  }

  function toggleMute() {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (realtimeActiveRef.current) {
      microphoneStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
    } else if (next) recognitionRef.current?.stop();
    else if (callActiveRef.current) { try { recognitionRef.current?.start(); } catch { /* already active */ } }
    postNativeVoiceBridgeEvent({ type: "call.muted", muted: next });
  }

  function repeatLastReply() {
    if (!lastSpoken) return;
    if (realtimeActiveRef.current) {
      sendRealtimeEvent({
        type: "response.create",
        response: { output_modalities: ["audio"], tool_choice: "none", instructions: "Repeat your immediately previous spoken answer exactly. Add nothing." },
      });
    } else speak(lastSpoken);
  }

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    if (!draft.trim() && draftAttachments.length === 0) return;
    if (attachmentUploadInProgress) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    if (attachmentUploadFailed) {
      setError("Retry or remove every failed attachment before sending.");
      return;
    }
    const attachments = draftAttachments.flatMap((item) =>
      item.status === "ready" && item.attachment ? [item.attachment] : []
    );
    void queueDraftMessage(selectedId, draft, attachments, replyingTo);
  }

  if (loading) return <div className={clsx("flex items-center justify-center text-body text-charcoal/50", drawer ? "h-full" : "h-[70vh]")}>Loading conversations…</div>;

  return (
    <div
      ref={workspaceRef}
      className={clsx(
        "conversation-accessible flex min-h-0 min-w-0 overflow-hidden border border-[#d4cbbd] bg-[#f5f1e8]",
        drawer
          ? "relative h-full w-full border-0"
          : "fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-20 h-[var(--conversation-vh,100dvh)] md:relative md:inset-auto md:z-auto md:h-[calc(100vh-7.5rem)] md:min-h-[560px]",
      )}
    >
      <aside className={clsx("flex min-h-0 w-full shrink-0 flex-col border-r border-[#d4cbbd] bg-[#ede8de]", drawer ? "md:w-64" : "md:w-80", selectedId && "hidden md:flex")}>
        <div className="flex items-center justify-between border-b border-[#d4cbbd] py-3 pl-20 pr-3 md:p-4">
          <p className="label-caps">Conversations</p>
          <button onClick={() => setNewOpen(true)} disabled={sending || voiceNoteRecording} className="bg-nearblack px-3 py-2 text-caption text-white disabled:opacity-30">New chat</button>
        </div>
        {data.conversations.length === 0 ? (
          <div className="p-6 text-body text-charcoal/60">
            <p>No conversations yet.</p>
            <button onClick={() => setNewOpen(true)} className="mt-4 border-b border-charcoal text-nearblack">Start with Aria, Marco or a teammate</button>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="grid grid-cols-2 border-b border-[#d4cbbd] bg-[#e8e2d7] p-1.5">
              <button
                type="button"
                onClick={() => setShowArchived(false)}
                className={clsx("px-3 py-2 text-caption font-medium", !showArchived ? "bg-[#f5f1e8] text-nearblack shadow-sm" : "text-charcoal/55")}
              >
                Chats <span className="ml-1 text-[10px] opacity-55">{activeConversations.length}</span>
              </button>
              <button
                type="button"
                onClick={() => setShowArchived(true)}
                className={clsx("px-3 py-2 text-caption font-medium", showArchived ? "bg-[#f5f1e8] text-nearblack shadow-sm" : "text-charcoal/55")}
              >
                Archived <span className="ml-1 text-[10px] opacity-55">{archivedConversations.length}</span>
              </button>
            </div>
            <div className="border-b border-[#d4cbbd] bg-[#ede8de] p-2.5">
              <label className="flex items-center gap-2 rounded-xl border border-[#d4cbbd] bg-[#f8f5ee] px-3 py-2 focus-within:border-nearblack">
                <span aria-hidden className="text-charcoal/40">⌕</span>
                <span className="sr-only">Search conversations</span>
                <input
                  type="search"
                  value={conversationFilter}
                  onChange={(event) => setConversationFilter(event.target.value)}
                  placeholder="Search chats"
                  className="min-w-0 flex-1 bg-transparent text-body text-nearblack outline-none placeholder:text-charcoal/40"
                />
              </label>
            </div>
            {filteredConversations.length === 0 ? (
              <p className="p-6 text-body text-charcoal/50">
                {conversationFilter.trim()
                  ? "No conversations match your search."
                  : showArchived ? "No archived conversations." : "No active conversations."}
              </p>
            ) : (
              <div className="min-h-0 overflow-y-auto">
                {filteredConversations.map((conversation) => (
                  <button key={conversation.id} onClick={() => selectConversation(conversation.id)} disabled={(sending || voiceNoteRecording) && selectedId !== conversation.id} className={clsx("flex w-full gap-3 border-b border-[#dcd6cc] p-4 text-left disabled:opacity-40", selectedId === conversation.id ? "bg-[#f5f1e8]" : "hover:bg-white/30")}>
                    <Avatar participant={conversation.participants.find((p) => !p.is_self) ?? conversation.participants[0]} />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className={clsx("min-w-0 flex-1 truncate text-body text-nearblack", conversation.unread_count > 0 ? "font-semibold" : "font-medium")}>{conversation.display_title}</span>
                        {conversation.unread_count > 0 && (
                          <span
                            className="flex min-h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-nearblack px-1.5 text-[10px] font-semibold text-white"
                            aria-label={`${conversation.unread_count} unread message${conversation.unread_count === 1 ? "" : "s"}`}
                          >
                            {conversation.unread_count > 99 ? "99+" : conversation.unread_count}
                          </span>
                        )}
                      </span>
                      <span className={clsx("mt-1 block truncate text-caption", draftsByConversation[conversation.id]?.trim() || latestOutboxByConversation.has(conversation.id) ? "font-medium text-red-800" : "text-charcoal/50") }>
                        {draftsByConversation[conversation.id]?.trim()
                          ? `Draft: ${draftsByConversation[conversation.id]}`
                          : latestOutboxByConversation.has(conversation.id)
                            ? `${latestOutboxByConversation.get(conversation.id)?.status === "failed" ? "Not sent" : "Sending"}: ${latestOutboxByConversation.get(conversation.id)?.body}`
                          : conversation.last_message?.body ?? "New conversation"}
                      </span>
                      {(conversation.pinned_at || conversation.notifications_muted) && (
                        <span className="mt-1.5 block text-[9px] font-medium uppercase tracking-[0.14em] text-charcoal/40">
                          {[conversation.pinned_at ? "Pinned" : null, conversation.notifications_muted ? "Muted" : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </aside>

      <section
        className={clsx("relative min-w-0 max-w-full flex-1 flex-col overflow-x-hidden", selectedId ? "flex" : "hidden md:flex")}
        onDragEnter={(event) => {
          if (!selectedId || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          attachmentDragDepthRef.current += 1;
          setAttachmentDropActive(true);
        }}
        onDragOver={(event) => {
          if (!selectedId || !event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
          if (attachmentDragDepthRef.current === 0) setAttachmentDropActive(false);
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return;
          event.preventDefault();
          attachmentDragDepthRef.current = 0;
          setAttachmentDropActive(false);
          if (!selectedId || !event.dataTransfer.files.length) return;
          void uploadSelectedFiles(event.dataTransfer.files);
        }}
      >
        {attachmentDropActive && selectedConversation && (
          <div className="pointer-events-none absolute inset-3 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-nearblack bg-[#f5f1e8]/95 p-6 text-center shadow-2xl" role="status" aria-live="polite">
            <div>
              <p className="font-display text-section text-nearblack">Drop photos or PDFs here</p>
              <p className="mt-2 text-caption text-charcoal/60">Up to 6 files · 25 MB each</p>
            </div>
          </div>
        )}
        {selectedConversation ? (
          <>
            <header className="sticky top-0 z-10 flex min-h-16 shrink-0 items-center gap-2 border-b border-[#d4cbbd] bg-[#f5f1e8]/95 py-2 pl-16 pr-2 backdrop-blur md:min-h-20 md:gap-3 md:px-4 md:py-3">
              <button onClick={() => selectConversation(null)} disabled={sending || voiceNoteRecording} className="flex h-11 w-8 shrink-0 items-center justify-center text-xl text-charcoal/70 disabled:opacity-30 md:hidden" aria-label="Back to conversations">‹</button>
              {headerParticipant && <Avatar participant={headerParticipant} />}
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-subhead text-nearblack">{selectedConversation.display_title}</h2>
                <p className="mt-1 truncate text-caption text-charcoal/50">{participants.map((participant) => participant.display_name).join(", ")}</p>
              </div>
              {callAgent && (
                <button disabled={voiceNoteRecording} onClick={() => void startCall()} aria-label={`Call ${callAgent.display_name}`} className="flex h-11 shrink-0 items-center justify-center gap-2 border border-nearblack px-3 text-nearblack hover:bg-nearblack hover:text-white disabled:opacity-35 md:px-4">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7.2 3.5 9.5 8l-2.2 1.7a15.4 15.4 0 0 0 7 7l1.7-2.2 4.5 2.3-.7 3.2c-.2.8-.9 1.4-1.8 1.4A15.5 15.5 0 0 1 2.6 6c0-.9.6-1.6 1.4-1.8l3.2-.7Z" />
                  </svg>
                  <span className="hidden text-subhead sm:inline">Call {callAgent.display_name}</span>
                </button>
              )}
              {callAgent?.agent_slug === "aria" && (
                <button
                  type="button"
                  onClick={() => {
                    setMeetingSourceCallId(null);
                    setMeetingMinutesId(null);
                    setMeetingModeOpen(true);
                  }}
                  aria-label="Ask Aria to take meeting minutes"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-[#c9b998] text-caption font-semibold text-nearblack hover:bg-[#e9e2d6] sm:w-auto sm:px-3"
                >
                  <span aria-hidden className="text-lg sm:hidden">≣</span>
                  <span className="hidden sm:inline">Take minutes</span>
                </button>
              )}
              <div className="relative shrink-0">
                <button
                  type="button"
                  onClick={() => setConversationMenuOpen((open) => !open)}
                  disabled={preferenceSaving}
                  aria-label="Conversation options"
                  aria-haspopup="menu"
                  aria-expanded={conversationMenuOpen}
                  className="flex h-11 w-11 items-center justify-center rounded-full text-xl tracking-[0.12em] text-charcoal/70 hover:bg-[#e9e2d6] disabled:opacity-40"
                >
                  <span aria-hidden>•••</span>
                </button>
                {conversationMenuOpen && (
                  <div role="menu" className="absolute right-0 top-12 z-30 w-56 overflow-hidden rounded-xl border border-[#d4cbbd] bg-white py-1 text-body text-nearblack shadow-2xl">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setConversationMenuOpen(false);
                        setMessageSearchOpen(true);
                      }}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[#f5f1e8]"
                    >
                      <span>Search messages</span>
                      <span aria-hidden className="text-charcoal/40">⌕</span>
                    </button>
                    {selectedConversation.kind === "group" && (
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setConversationMenuOpen(false);
                          setGroupDetailsOpen(true);
                        }}
                        className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[#f5f1e8]"
                      >
                        <span>Group details</span>
                        <span aria-hidden className="text-charcoal/40">◎</span>
                      </button>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void updateConversationPreferences({ notifications_muted: !selectedConversation.notifications_muted })}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[#f5f1e8]"
                    >
                      <span>{selectedConversation.notifications_muted ? "Unmute notifications" : "Mute notifications"}</span>
                      <span aria-hidden className="text-charcoal/40">{selectedConversation.notifications_muted ? "◉" : "○"}</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void updateConversationPreferences({ pinned: !selectedConversation.pinned_at })}
                      className="flex w-full items-center justify-between gap-4 px-4 py-3 text-left hover:bg-[#f5f1e8]"
                    >
                      <span>{selectedConversation.pinned_at ? "Unpin conversation" : "Pin conversation"}</span>
                      <span aria-hidden className="text-charcoal/40">⌖</span>
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => void updateConversationPreferences({ archived: !selectedConversation.archived_at })}
                      className="flex w-full items-center justify-between gap-4 border-t border-[#ece6dc] px-4 py-3 text-left hover:bg-[#f5f1e8]"
                    >
                      <span>{selectedConversation.archived_at ? "Unarchive conversation" : "Archive conversation"}</span>
                      <span aria-hidden className="text-charcoal/40">▣</span>
                    </button>
                  </div>
                )}
              </div>
            </header>

            {visibleAgentTasks.length > 0 && (
              <section className="w-full min-w-0 max-w-full shrink-0 overflow-hidden border-b border-[#d4cbbd] bg-[#eee9df] px-3 py-2.5 md:px-4" aria-label="Agent work">
                <div className="mb-2 flex items-center justify-between gap-3">
                  <p className="label-caps">Agent work</p>
                  {visibleAgentTasks.length > 1 ? (
                    <button
                      type="button"
                      onClick={() => setAgentWorkExpanded((expanded) => !expanded)}
                      className="text-caption font-medium text-charcoal/60 md:hidden"
                    >
                      {agentWorkExpanded ? "Show latest only" : `Show ${visibleAgentTasks.length - 1} more`}
                    </button>
                  ) : <p className="text-[10px] text-charcoal/45">Continues after you leave this chat</p>}
                </div>
                <div className="grid max-h-[46vh] min-w-0 max-w-full grid-cols-1 gap-3 overflow-y-auto pb-1 md:flex md:max-h-52 md:snap-x md:overflow-x-auto md:overflow-y-hidden">
                  {visibleAgentTasks.map((task, index) => (
                    <div key={task.id} className={clsx("min-w-0 max-w-full", index > 0 && !agentWorkExpanded && "hidden md:block", "md:w-80 md:shrink-0 md:snap-start") }>
                      <AgentTaskCard task={task} compact onAction={handleTaskAction} />
                    </div>
                  ))}
                </div>
              </section>
            )}

            {messageSearchOpen && (
              <div role="dialog" aria-modal="true" aria-label="Search messages and files" className="absolute inset-0 z-40 flex min-h-0 flex-col bg-[#f5f1e8]">
                <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[#d4cbbd] py-3 pl-16 pr-3 md:min-h-20 md:px-5">
                  <div className="min-w-0">
                    <p className="label-caps">Search messages and files</p>
                    <p className="mt-1 truncate text-caption text-charcoal/50">{selectedConversation.display_title}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMessageSearchOpen(false)}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-charcoal/65 hover:bg-[#e9e2d6]"
                    aria-label="Close message search"
                  >
                    ×
                  </button>
                </div>
                <form onSubmit={(event) => void runMessageSearch(event)} className="shrink-0 border-b border-[#d4cbbd] p-3 md:p-5">
                  <div className="mx-auto flex max-w-3xl gap-2">
                    <input
                      autoFocus
                      type="search"
                      value={messageSearch.query}
                      maxLength={100}
                      onChange={(event) => setMessageSearch((current) => ({ ...current, query: event.target.value, error: null }))}
                      placeholder="Search messages and file names"
                      className="min-w-0 flex-1 rounded-xl border border-[#cfc6b8] bg-white px-4 py-3 text-body text-nearblack outline-none focus:border-nearblack"
                    />
                    <button
                      disabled={messageSearch.loading || messageSearch.query.trim().length < 2}
                      className="rounded-xl bg-nearblack px-4 py-3 text-subhead text-white disabled:opacity-30"
                    >
                      {messageSearch.loading ? "Searching…" : "Search"}
                    </button>
                  </div>
                  {messageSearch.error && <p className="mx-auto mt-2 max-w-3xl text-caption text-red-700">{messageSearch.error}</p>}
                </form>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  {messageSearch.hasSearched && !messageSearch.loading && messageSearch.results.length === 0 && !messageSearch.error && (
                    <p className="p-8 text-center text-body text-charcoal/50">No matching messages or files.</p>
                  )}
                  {!messageSearch.hasSearched && (
                    <p className="p-8 text-center text-body text-charcoal/50">Search the full conversation history and private file names, not just what is currently on screen.</p>
                  )}
                  {messageSearch.results.map((message) => (
                    <button
                      key={message.id}
                      type="button"
                      onClick={() => void openMessageSearchResult(message.id)}
                      className="block w-full border-b border-[#ded7cc] px-4 py-4 text-left hover:bg-white/50 md:px-8"
                    >
                      <span className="mx-auto block max-w-3xl">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className="text-caption font-semibold text-nearblack">{message.author.display_name}</span>
                          <span className="shrink-0 text-[10px] text-charcoal/40">{timeLabel(message.created_at)}</span>
                        </span>
                        <span className="mt-1.5 block max-h-12 overflow-hidden text-body leading-6 text-charcoal/70">{message.body}</span>
                        {(message.search_match?.attachment_filenames.length ?? 0) > 0 && (
                          <span className="mt-2 flex flex-wrap gap-1.5">
                            {message.search_match?.attachment_filenames.map((filename, index) => (
                              <span key={`${message.id}:${index}:${filename}`} className="max-w-full truncate rounded-full bg-[#e8e1d5] px-2.5 py-1 text-[10px] font-medium text-charcoal/70">
                                File · {filename}
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {historyAnchorMessageId && (
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[#d4cbbd] bg-[#e9e2d6] px-3 py-2 text-caption text-charcoal/65 md:px-5">
                <span>Viewing an earlier message and its surrounding context.</span>
                <button type="button" onClick={() => void returnToLatestMessages()} className="shrink-0 font-semibold text-nearblack underline underline-offset-2">
                  Back to latest
                </button>
              </div>
            )}

            {pinnedMessages.length > 0 && (
              <div className="shrink-0 border-b border-[#d4cbbd] bg-[#f5f1e8] px-3 py-2 md:px-5" aria-label="Pinned messages">
                <div className="mx-auto flex max-w-3xl items-center gap-2 overflow-x-auto">
                  <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-charcoal/45">Pinned</span>
                  {pinnedMessages.map((message) => (
                    <button
                      key={message.id}
                      type="button"
                      onClick={() => jumpToReferencedMessage(message.id)}
                      className="max-w-64 shrink-0 truncate rounded-full border border-[#d4cbbd] bg-white/70 px-3 py-1.5 text-left text-caption text-charcoal/70 hover:border-charcoal/40 hover:text-nearblack"
                    >
                      <span aria-hidden>📌 </span>{message.body}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div
              ref={messagesScrollerRef}
              onScroll={(event) => {
                const pane = event.currentTarget;
                shouldStickToBottomRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 96;
                const newestCanonicalMessage = messages.at(-1);
                if (selectedId && newestCanonicalMessage && shouldStickToBottomRef.current) {
                  void markConversationRead(selectedId, newestCanonicalMessage.id);
                }
              }}
              className="min-h-0 flex-1 overscroll-contain overflow-y-auto bg-[#faf7f0] px-3 py-4 md:px-8 md:py-6"
            >
              {!historyAnchorMessageId && hasOlderMessages && (
                <div className="mx-auto mb-5 max-w-3xl text-center">
                  <button
                    type="button"
                    onClick={() => void loadEarlierMessages()}
                    disabled={historyLoading}
                    className="rounded-full border border-[#cfc6b8] bg-[#f5f1e8] px-4 py-2 text-caption font-medium text-nearblack shadow-sm disabled:opacity-40"
                  >
                    {historyLoading ? "Loading earlier messages…" : "Load earlier messages"}
                  </button>
                </div>
              )}
              {messages.length === 0 && <p className="mx-auto mt-20 max-w-sm text-center text-body text-charcoal/50">This is the beginning of the conversation. Its history will stay here for everyone in the chat.</p>}
              <div className="mx-auto max-w-3xl space-y-4">
                {timelineItems.map(({ message, pending }, index) => {
                  const own = message.author.is_self;
                  const previousMessage = timelineItems[index - 1]?.message;
                  const showDaySeparator = !previousMessage || conversationDayKey(previousMessage.created_at) !== conversationDayKey(message.created_at);
                  const daySeparator = showDaySeparator ? (
                    <div className="sticky top-2 z-[5] flex justify-center py-1" role="separator" aria-label={conversationDayLabel(message.created_at)}>
                      <span className="rounded-full border border-[#d4cbbd] bg-[#f5f1e8]/95 px-3 py-1 text-[11px] font-semibold text-charcoal/60 shadow-sm backdrop-blur">
                        {conversationDayLabel(message.created_at)}
                      </span>
                    </div>
                  ) : null;
                  const record = message.kind === "call_record" || message.kind === "meeting_record" || message.kind === "system";
                  const voiceNoteAttachment = message.attachments.find((attachment) => (
                    conversationAttachmentKind(attachment.mime_type) === "audio"
                    && isVoiceNoteMetadata(attachment.metadata)
                  )) ?? null;
                  const repliedMessage = message.reply_to_id ? timelineMessageById.get(message.reply_to_id) ?? null : null;
                  const canEdit = own
                    && !pending
                    && !message.deleted_at
                    && !voiceNoteAttachment
                    && message.kind === "text"
                    && Date.now() - new Date(message.created_at).getTime() <= 15 * 60 * 1000;
                  if (record) return (
                    <Fragment key={message.id}>
                      {daySeparator}
                      <div id={`conversation-message-${message.id}`} className="border-y border-[#d4cbbd] py-3 text-center">
                        <p className="label-caps">{message.kind === "call_record" ? "Call completed" : message.kind === "meeting_record" ? "Meeting completed" : "Group update"}</p>
                        <p className="mt-2 text-caption text-charcoal/60">{message.body}</p>
                        {message.kind === "meeting_record" && typeof message.metadata.meeting_minutes_id === "string" && (
                          <button
                            type="button"
                            onClick={() => {
                              setMeetingSourceCallId(null);
                              setMeetingMinutesId(message.metadata.meeting_minutes_id as string);
                              setMeetingModeOpen(true);
                            }}
                            className="mt-3 rounded-full border border-nearblack px-4 py-2 text-caption font-semibold text-nearblack hover:bg-nearblack hover:text-white"
                          >
                            Open filed minutes
                          </button>
                        )}
                      </div>
                    </Fragment>
                  );
                  return (
                    <Fragment key={message.id}>
                    {daySeparator}
                    <div id={`conversation-message-${message.id}`} className={clsx("flex gap-3", own && "flex-row-reverse")}>
                      <Avatar participant={message.author} />
                      <div
                        data-message-long-press={message.id}
                        onPointerDown={(event) => startMessageLongPress(message.id, event)}
                        onPointerMove={moveMessageLongPress}
                        onPointerUp={cancelMessageLongPress}
                        onPointerCancel={cancelMessageLongPress}
                        className={clsx("group relative min-w-0 max-w-[78%] border px-3 py-3 md:px-4", own ? "border-nearblack bg-nearblack text-white" : "border-[#d4cbbd] bg-[#f5f1e8] text-charcoal")}
                      >
                        <div className="flex items-baseline gap-2">
                          <span className={clsx("text-caption font-semibold", own ? "text-white" : "text-nearblack")}>{message.author.display_name}</span>
                          <span className={clsx("text-[10px]", own ? "text-white/45" : "text-charcoal/40")}>{timeLabel(message.created_at)}</span>
                          <button
                            type="button"
                            onClick={() => setMessageMenuId((current) => current === message.id ? null : message.id)}
                            aria-label={`Actions for message from ${message.author.display_name}`}
                            aria-haspopup="menu"
                            aria-expanded={messageMenuId === message.id}
                            className={clsx("ml-auto -my-2 -mr-2 flex h-11 w-11 items-center justify-center rounded-full text-[11px] tracking-widest transition-opacity focus:opacity-100 md:opacity-0 md:group-hover:opacity-100", own ? "text-white/65 hover:bg-white/10" : "text-charcoal/55 hover:bg-black/5")}
                          >
                            <span aria-hidden>•••</span>
                          </button>
                        </div>
                        {messageMenuId === message.id && (
                          <div role="menu" className="absolute right-2 top-10 z-20 w-48 overflow-hidden rounded-xl border border-[#d4cbbd] bg-white py-1 text-caption text-nearblack shadow-2xl">
                            {!pending && !message.deleted_at && (
                              <div className="flex items-center justify-between border-b border-[#eee8de] px-2 py-2" aria-label="React to message">
                                {CONVERSATION_MESSAGE_REACTIONS.map((reaction) => (
                                  <button
                                    key={reaction}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => void toggleMessageReaction(message, reaction)}
                                    aria-label={`React ${reaction}`}
                                    className="flex h-11 w-11 items-center justify-center rounded-full text-base hover:bg-[#f5f1e8]"
                                  >
                                    {reaction}
                                  </button>
                                ))}
                              </div>
                            )}
                            {!pending && !message.deleted_at && (
                              <button type="button" role="menuitem" onClick={() => beginReply(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                Reply
                              </button>
                            )}
                            {!pending && !message.deleted_at && message.kind === "text" && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMessageMenuId(null);
                                  setForwardingMessage(message);
                                }}
                                className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]"
                              >
                                Forward
                              </button>
                            )}
                            {!message.deleted_at && (
                              <button type="button" role="menuitem" onClick={() => void copyCanonicalMessage(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                Copy
                              </button>
                            )}
                            {canEdit && (
                              <button type="button" role="menuitem" onClick={() => beginMessageEdit(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                Edit
                              </button>
                            )}
                            {!pending && !message.deleted_at && (
                              <button type="button" role="menuitem" onClick={() => void toggleMessagePin(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                {message.pinned_at ? "Unpin" : "Pin message"}
                              </button>
                            )}
                            {own && !pending && !message.deleted_at && message.kind === "text" && (
                              <button type="button" role="menuitem" onClick={() => void deleteMessageRecoverably(message)} className="block w-full px-4 py-2.5 text-left text-red-700 hover:bg-red-50">
                                Delete
                              </button>
                            )}
                            {own && message.deleted_at && (
                              <button type="button" role="menuitem" onClick={() => void restoreMessage(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                Restore
                              </button>
                            )}
                          </div>
                        )}
                        {message.reply_to_id && !message.deleted_at && (
                          <button
                            type="button"
                            onClick={() => jumpToReferencedMessage(message.reply_to_id!)}
                            className={clsx("mt-2 block w-full border-l-2 px-3 py-2 text-left", own ? "border-white/40 bg-white/10" : "border-charcoal/30 bg-white/55")}
                          >
                            <span className={clsx("block truncate text-[10px] font-semibold", own ? "text-white/65" : "text-charcoal/55")}>{repliedMessage?.author.display_name ?? "Earlier message"}</span>
                            <span className={clsx("mt-1 block truncate text-caption", own ? "text-white/80" : "text-charcoal/70")}>{repliedMessage?.deleted_at ? "Message deleted" : repliedMessage?.body ?? "Open original message"}</span>
                          </button>
                        )}
                        {editingMessageId === message.id ? (
                          <div className="mt-3">
                            <textarea
                              autoFocus
                              value={editingMessageBody}
                              onChange={(event) => setEditingMessageBody(event.target.value)}
                              rows={3}
                              maxLength={20000}
                              className="w-full resize-y rounded-lg border border-white/25 bg-white/10 px-3 py-2 text-body text-white outline-none focus:border-white/60"
                            />
                            <div className="mt-2 flex justify-end gap-2 text-caption">
                              <button type="button" onClick={cancelMessageEdit} className="rounded-lg px-3 py-2 text-white/70 hover:bg-white/10">Cancel</button>
                              <button type="button" onClick={() => void saveMessageEdit(message)} disabled={messageMutationId === message.id || !editingMessageBody.trim()} className="rounded-lg bg-white px-3 py-2 font-semibold text-nearblack disabled:opacity-40">Save</button>
                            </div>
                            <p className="mt-2 text-[9px] uppercase tracking-widest text-white/40">Editing changes the message history; it does not resend the request.</p>
                          </div>
                        ) : !voiceNoteAttachment ? (
                          <p className={clsx("mt-2 whitespace-pre-wrap text-body leading-relaxed", message.deleted_at && "italic opacity-60")}>{message.body}</p>
                        ) : null}
                        {!message.deleted_at && (message.attachments ?? []).length > 0 && (
                          <div className={clsx("mt-3 grid gap-2", message.attachments.length > 1 && "grid-cols-2")}>
                            {message.attachments.map((attachment) => {
                              const attachmentKind = conversationAttachmentKind(attachment.mime_type);
                              const imageAttachment = attachmentKind === "image";
                              if (imageAttachment && attachment.url) return (
                                <button
                                  key={attachment.id}
                                  type="button"
                                  onClick={() => setMediaViewer({ url: attachment.url!, filename: attachment.filename, author: message.author.display_name })}
                                  aria-label={`View ${attachment.filename} full screen`}
                                  className={clsx("block w-full overflow-hidden border text-left", own ? "border-white/15 bg-white/10" : "border-[#d4cbbd] bg-white/50")}
                                >
                                  <Image
                                    src={attachment.url}
                                    alt={attachment.filename}
                                    width={480}
                                    height={320}
                                    unoptimized
                                    className="h-36 w-full object-cover md:h-48"
                                  />
                                  <span className="block truncate px-2 py-2 text-[10px] opacity-65">{attachment.filename}</span>
                                </button>
                              );
                              if (attachmentKind === "audio" && attachment.url && isVoiceNoteMetadata(attachment.metadata)) return (
                                <div key={attachment.id} className={clsx("min-w-[240px] rounded-xl border p-3", own ? "border-white/15 bg-white/10" : "border-[#d4cbbd] bg-white/55") }>
                                  <div className="mb-2 flex items-center justify-between gap-3 text-[10px] uppercase tracking-widest opacity-60">
                                    <span>Voice note</span>
                                    <span>{voiceNoteDurationLabel(attachment.metadata.duration_ms)}</span>
                                  </div>
                                  <audio controls playsInline preload="metadata" src={attachment.url} className="h-10 w-full" aria-label={`Voice note from ${message.author.display_name}`} />
                                </div>
                              );
                              return (
                                <a key={attachment.id} href={attachment.url ?? undefined} target="_blank" rel="noreferrer" className={clsx("flex min-w-0 items-center gap-3 border px-3 py-3", own ? "border-white/15 bg-white/10" : "border-[#d4cbbd] bg-white/50", !attachment.url && "pointer-events-none opacity-50")}>
                                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center border border-current text-[10px] font-semibold">{imageAttachment ? "IMG" : attachmentKind === "audio" ? "AUDIO" : "PDF"}</span>
                                  <span className="min-w-0">
                                    <span className="block truncate text-caption font-semibold">{attachment.filename}</span>
                                    <span className="mt-1 block text-[10px] opacity-55">{fileSizeLabel(attachment.byte_size)}</span>
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        )}
                        {!message.deleted_at && (message.reactions ?? []).length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Message reactions">
                            {(message.reactions ?? []).map((reaction) => (
                              <button
                                key={reaction.reaction}
                                type="button"
                                onClick={() => void toggleMessageReaction(message, reaction.reaction)}
                                disabled={messageMutationId === message.id}
                                aria-label={`${reaction.reaction}, ${reaction.count}${reaction.self_reacted ? ", reacted by you" : ""}`}
                                className={clsx(
                                  "rounded-full border px-2 py-1 text-caption disabled:opacity-40",
                                  reaction.self_reacted
                                    ? own ? "border-white/55 bg-white/20 text-white" : "border-charcoal/45 bg-white text-nearblack"
                                    : own ? "border-white/20 bg-white/10 text-white/75" : "border-[#d4cbbd] bg-white/60 text-charcoal/65"
                                )}
                              >
                                {reaction.reaction} {reaction.count}
                              </button>
                            ))}
                          </div>
                        )}
                        {!message.deleted_at && message.pinned_at && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Pinned</p>}
                        {!message.deleted_at && message.metadata.source === "forward" && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Forwarded</p>}
                        {!message.deleted_at && message.metadata.source === "voice_note" && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Voice note</p>}
                        {!message.deleted_at && message.metadata.source === "voice" && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Voice transcript</p>}
                        {!message.deleted_at && message.edited_at && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Edited</p>}
                        {own && (pending || message.client_message_id) && (
                          <div className="mt-2 flex items-center justify-end gap-2 text-[9px] uppercase tracking-widest text-white/45">
                            <span>
                              {pending?.status === "failed"
                                ? "Not sent"
                                : pending?.status === "queued"
                                  ? "Waiting for connection"
                                  : pending?.status === "sending"
                                    ? "Sending…"
                                    : message.client_message_id
                                      ? "Delivered"
                                      : ""}
                            </span>
                            {pending?.status === "failed" && pending.retryable && (
                              <button
                                type="button"
                                onClick={() => retryOutboxEntry(pending)}
                                className="font-semibold text-white underline underline-offset-2"
                              >
                                Retry
                              </button>
                            )}
                            {pending?.status === "failed" && (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void copyOutboxEntry(pending)}
                                  className="font-semibold text-white underline underline-offset-2"
                                >
                                  Copy
                                </button>
                                {!pending.retryable && (
                                  <button
                                    type="button"
                                    onClick={() => discardFailedOutboxEntry(pending)}
                                    className="font-semibold text-white underline underline-offset-2"
                                  >
                                    Discard
                                  </button>
                                )}
                              </>
                            )}
                          </div>
                        )}
                        {pending?.status === "failed" && pending.error && (
                          <p className="mt-1 text-right text-[10px] text-white/60">{pending.error}</p>
                        )}
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
                {!historyAnchorMessageId && agentActivity.map((activity) => {
                  const agent = participants.find((participant) => participant.id === activity.agent_id && participant.type === "agent");
                  if (!agent) return null;
                  return (
                    <div key={activity.agent_id} className="flex gap-3" role="status" aria-live="polite">
                      <Avatar participant={agent} />
                      <div className="max-w-[78%] rounded-2xl rounded-tl-sm border border-[#d4cbbd] bg-[#f5f1e8] px-4 py-3 text-charcoal">
                        <p className="text-caption font-semibold text-nearblack">{agent.display_name}</p>
                        <div className="mt-2 flex items-center gap-2 text-caption text-charcoal/60">
                          <span>{activity.status === "processing" ? activity.progress_label ?? "Working on your request" : "Waiting to start"}</span>
                          <span className="flex gap-1" aria-hidden>
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-charcoal/45" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-charcoal/45 [animation-delay:150ms]" />
                            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-charcoal/45 [animation-delay:300ms]" />
                          </span>
                        </div>
                        {activity.pending_turns > 1 && (
                          <p className="mt-1 text-[10px] text-charcoal/40">{activity.pending_turns} requests in progress</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <form onSubmit={submitDraft} className="shrink-0 border-t border-[#d4cbbd] bg-[#f5f1e8] px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 md:p-4">
              {!online && (
                <p className="mx-auto mb-2 max-w-3xl text-center text-[10px] font-medium text-amber-800" role="status">
                  Offline — messages will stay on this device and send when the connection returns.
                </p>
              )}
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                capture="environment"
                className="hidden"
                onChange={(event) => {
                  void uploadSelectedFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf,.pdf"
                multiple
                className="hidden"
                onChange={(event) => {
                  void uploadSelectedFiles(event.currentTarget.files);
                  event.currentTarget.value = "";
                }}
              />
              <div className="mx-auto max-w-3xl rounded-2xl border border-[#cfc6b8] bg-white shadow-[0_8px_30px_rgba(35,31,25,0.08)] focus-within:border-nearblack">
                {replyingTo && (
                  <div className="flex items-start gap-3 border-b border-[#e3ddd2] px-3 py-2.5">
                    <div className="min-w-0 flex-1 border-l-2 border-nearblack pl-3">
                      <p className="text-[10px] font-semibold text-nearblack">Replying to {replyingTo.author.display_name}</p>
                      <p className="mt-1 truncate text-caption text-charcoal/55">{replyingTo.body}</p>
                    </div>
                    <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-lg text-charcoal/50 hover:bg-[#f1ece3]">
                      ×
                    </button>
                  </div>
                )}
                {draftAttachments.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto border-b border-[#e3ddd2] p-2.5">
                    {draftAttachments.map((item) => (
                      <div key={item.localId} className="relative flex w-44 shrink-0 items-center gap-2 rounded-xl border border-[#ded7cc] bg-[#faf7f0] p-2">
                        {item.previewUrl ? (
                          <Image src={item.previewUrl} alt="" width={48} height={48} unoptimized className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                        ) : (
                          <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#e9e2d6] text-[10px] font-semibold text-charcoal">
                            {item.mimeType.startsWith("image/") ? "IMG" : item.voiceNoteDurationMs != null ? "VOICE" : "PDF"}
                          </span>
                        )}
                        <div className="min-w-0 flex-1 pr-4">
                          <span className="block truncate text-caption font-semibold text-nearblack">{item.filename}</span>
                          <span className={clsx("mt-1 block truncate text-[10px]", item.status === "error" ? "text-red-700" : "text-charcoal/50")}>
                            {item.status === "preparing"
                              ? "Preparing…"
                              : item.status === "uploading"
                                ? item.voiceNoteDurationMs != null ? "Uploading voice note…" : "Uploading…"
                                : item.status === "error"
                                  ? item.error
                                  : item.voiceNoteDurationMs != null
                                    ? `${voiceNoteDurationLabel(item.voiceNoteDurationMs)} · ${fileSizeLabel(item.byteSize)}`
                                    : fileSizeLabel(item.byteSize)}
                          </span>
                          {item.status === "error" && (item.file || item.stagedAttachmentId) && (
                            <button
                              type="button"
                              onClick={() => retryDraftAttachment(item.localId)}
                              className="mt-1 text-[10px] font-semibold text-red-800 underline underline-offset-2"
                            >
                              Retry upload
                            </button>
                          )}
                        </div>
                        <button
                          type="button"
                          onClick={() => removeDraftAttachment(item.localId)}
                          aria-label={item.status === "preparing" || item.status === "uploading"
                            ? `Cancel upload of ${item.filename}`
                            : `Remove ${item.filename}`}
                          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-full bg-nearblack text-[14px] text-white"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {attachmentUploadFailed && (
                  <p className="border-b border-[#e3ddd2] px-3 py-2 text-[10px] text-red-700">
                    Retry or remove failed files before sending, so nothing is silently left behind.
                  </p>
                )}
                <textarea
                  ref={composerInputRef}
                  value={draft}
                  disabled={sending || voiceNoteRecording}
                  onChange={(event) => selectedId && updateDraft(selectedId, event.target.value)}
                  onPaste={(event) => {
                    if (!event.clipboardData.files.length) return;
                    event.preventDefault();
                    void uploadSelectedFiles(event.clipboardData.files);
                  }}
                  onFocus={() => setAttachmentMenuOpen(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  placeholder={participants.some((p) => p.type === "agent") && participants.length > 2 ? "Message the group — use @Aria or @Marco" : `Message ${callAgent?.display_name ?? "the conversation"}`}
                  className="max-h-36 min-h-12 w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-3 text-[16px] outline-none disabled:opacity-60 md:text-body"
                />
                <div className="flex items-center justify-between gap-2 px-2.5 pb-2.5">
                  <div className={clsx("relative", voiceNoteRecording && "hidden")}>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => setAttachmentMenuOpen((open) => !open)}
                      aria-label="Add photos or files"
                      aria-expanded={attachmentMenuOpen}
                      className="flex h-11 w-11 items-center justify-center rounded-full border border-[#d7d0c5] text-xl text-nearblack hover:bg-[#f1ece3] disabled:opacity-40"
                    >
                      +
                    </button>
                    {attachmentMenuOpen && (
                      <div className="absolute bottom-12 left-0 z-20 w-52 overflow-hidden rounded-xl border border-[#d4cbbd] bg-white py-1 shadow-2xl">
                        <button type="button" onClick={() => cameraInputRef.current?.click()} className="flex w-full items-center gap-3 px-4 py-3 text-left text-body text-nearblack hover:bg-[#f5f1e8]">
                          <span aria-hidden>◉</span> Take a photo
                        </button>
                        <button type="button" onClick={() => fileInputRef.current?.click()} className="flex w-full items-center gap-3 px-4 py-3 text-left text-body text-nearblack hover:bg-[#f5f1e8]">
                          <span aria-hidden>＋</span> Photos or PDF
                        </button>
                      </div>
                    )}
                  </div>
                  <VoiceNoteRecorder
                    conversationId={selectedConversation.id}
                    disabled={sending || attachmentUploadInProgress || draftAttachments.length >= MAX_CONVERSATION_ATTACHMENTS}
                    onRecorded={addRecordedVoiceNote}
                    onError={setError}
                    onRecordingChange={setVoiceNoteRecording}
                  />
                  {!voiceNoteRecording && <span className="hidden flex-1 text-center text-[10px] text-charcoal/40 sm:block">Up to 6 files · voice notes up to 5 min</span>}
                  {!voiceNoteRecording && (
                    <button
                      disabled={composerBusy || attachmentUploadFailed || (!draft.trim() && !draftAttachments.some((item) => item.status === "ready"))}
                      aria-label="Send message"
                      className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-nearblack px-3 text-subhead text-white disabled:opacity-30"
                    >
                      <span aria-hidden>↑</span><span className="sr-only">Send</span>
                    </button>
                  )}
                </div>
              </div>
              {error && <p className="mx-auto mt-2 max-w-3xl text-caption text-red-700">{error}</p>}
              {notice && <p className="mx-auto mt-2 max-w-3xl text-caption text-green-800">{notice}</p>}
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-body text-charcoal/45">Choose a conversation or start a new one.</div>
        )}
      </section>

      {mediaViewer && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="conversation-media-viewer-title"
          className="fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-[85] flex h-[var(--conversation-vh,100dvh)] min-h-0 flex-col bg-black text-white"
        >
          <header className="flex min-h-16 shrink-0 items-center gap-3 border-b border-white/15 px-3 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-5 md:py-4">
            <div className="min-w-0 flex-1">
              <h2 id="conversation-media-viewer-title" className="truncate text-body font-semibold">{mediaViewer.filename}</h2>
              <p className="mt-1 truncate text-caption text-white/55">Shared by {mediaViewer.author}</p>
            </div>
            <a href={mediaViewer.url} target="_blank" rel="noreferrer" className="flex min-h-11 items-center rounded-full border border-white/25 px-4 text-caption font-semibold text-white">
              Open original
            </a>
            <button autoFocus type="button" onClick={() => setMediaViewer(null)} aria-label="Close photo viewer" className="flex h-11 w-11 items-center justify-center rounded-full border border-white/25 text-xl text-white">
              ×
            </button>
          </header>
          <div className="relative min-h-0 flex-1 overflow-hidden p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:p-6">
            <Image src={mediaViewer.url} alt={mediaViewer.filename} fill sizes="100vw" unoptimized className="object-contain" />
          </div>
        </div>
      )}

      {newOpen && <NewConversation people={data.people} onClose={() => setNewOpen(false)} onCreated={(id) => {
        draftAttachmentsRef.current = draftAttachmentsByConversationRef.current.get(id) ?? [];
        setDraftAttachments(draftAttachmentsRef.current);
        setNewOpen(false);
        setShowArchived(false);
        hasInitialConversationSelectionRef.current = true;
        historyAnchorMessageIdRef.current = null;
        historyExpandedRef.current = false;
        setHistoryAnchorMessageId(null);
        setHasOlderMessages(false);
        setReplyingTo(null);
        setMessageMenuId(null);
        selectedIdRef.current = id;
        setSelectedId(id);
        void loadConversations();
      }} />}

      {forwardingMessage && (
        <ForwardMessageDialog
          message={forwardingMessage}
          conversations={activeConversations}
          onClose={() => setForwardingMessage(null)}
          onForwarded={(destinationIds) => {
            setForwardingMessage(null);
            setError(null);
            setNotice(`Message forwarded to ${destinationIds.length} chat${destinationIds.length === 1 ? "" : "s"}.`);
            window.setTimeout(() => setNotice(null), 3500);
            void loadConversations({ preserveError: true });
            const selectedConversationId = selectedIdRef.current;
            if (selectedConversationId && destinationIds.includes(selectedConversationId)) {
              void loadMessages(selectedConversationId, { latest: true });
            }
          }}
        />
      )}

      {groupDetailsOpen && selectedConversation?.kind === "group" && (
        <GroupDetailsDialog
          conversation={selectedConversation}
          participants={participants}
          people={data.people}
          onClose={() => setGroupDetailsOpen(false)}
          onChanged={async () => {
            const conversationId = selectedIdRef.current;
            await loadConversations({ preserveError: true });
            if (conversationId) await loadMessages(conversationId, { latest: true });
          }}
          onLeft={async () => {
            setGroupDetailsOpen(false);
            selectConversation(null);
            await loadConversations({ preserveError: true });
          }}
        />
      )}

      {(callOpening || callId || callError) && callAgent && (
        <div role="dialog" aria-modal="true" aria-labelledby="active-call-agent" className={clsx(
          "visible pointer-events-auto fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-[70] flex h-[var(--conversation-vh,100dvh)] min-h-0 flex-col overflow-hidden bg-nearblack text-white",
          drawer && callCompact && "md:inset-auto md:bottom-5 md:right-5 md:h-auto md:w-[26rem] md:max-w-[calc(100vw-2.5rem)] md:rounded-2xl md:border md:border-white/15 md:shadow-[0_20px_70px_rgba(20,18,15,0.45)]",
        )}>
          <header className="flex shrink-0 items-center gap-3 border-b border-white/10 px-3 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] md:px-6 md:py-4">
            <div className={clsx("relative", callState === "speaking" && "animate-pulse")}>
              <Avatar participant={callAgent} />
              <span className={clsx("absolute -bottom-1 -right-1 h-3.5 w-3.5 rounded-full border-2 border-nearblack", callState === "reconnecting" ? "bg-[#C9971E]" : "bg-[#66a466]")} />
            </div>
            <div className="min-w-0 flex-1">
              <h2 id="active-call-agent" className="truncate text-body font-semibold">{callAgent.display_name}</h2>
              <p className={clsx("mt-0.5 text-[12px] font-semibold uppercase tracking-[0.14em]", callError ? "text-[#e28b8b]" : "text-sand")} role="status" aria-live="polite" aria-atomic="true">{callError ? "Call interrupted" : callState}</p>
            </div>
            <p className="hidden truncate text-caption text-white/40 sm:block">{selectedConversation?.display_title}</p>
            {drawer && (
              <>
                {callCompact && (
                  <button
                    type="button"
                    onClick={toggleMute}
                    className="hidden rounded-full border border-white/25 px-3 py-2 text-caption md:block"
                  >
                    {muted ? "Unmute" : "Mute"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onCallCompactChange?.(!callCompact)}
                  className="hidden rounded-full border border-white/25 px-3 py-2 text-caption md:block"
                >
                  {callCompact ? "Expand" : "Minimise"}
                </button>
              </>
            )}
            <button onClick={() => void endCall()} className="min-h-11 rounded-full border border-white/25 px-4 py-2 text-caption">End call</button>
          </header>
          <main className={clsx("min-h-0 flex-1 flex-col", drawer && callCompact ? "flex md:hidden" : "flex")}>
            <section className="flex min-h-0 flex-1 flex-col bg-white/[0.025]" aria-label="Background agent work">
              <div className="flex items-end justify-between gap-4 border-b border-white/10 px-4 py-3 md:px-6 md:py-4">
                <div>
                  <p className="label-caps text-sand">Agent work</p>
                  <p className="mt-1 text-[15px] text-white/65 md:text-[16px]">Drafts and results appear here while you keep talking.</p>
                </div>
                <p className="shrink-0 text-caption text-white/35">Continues after the call</p>
              </div>
              {callError && (
                <div className="mx-4 mt-4 flex items-center justify-between gap-3 rounded-xl border border-red-300/30 bg-red-950/30 p-3 text-body text-red-100 md:mx-6">
                  <p>{callError}</p>
                  {callState === "reconnecting" && callId && realtimeActiveRef.current && (
                    <button
                      type="button"
                      onClick={retryRealtimeCall}
                      className="shrink-0 rounded-full border border-red-100/40 px-3 py-2 text-caption font-semibold text-white"
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              )}
              <div className="grid min-h-0 flex-1 auto-rows-max grid-cols-1 gap-4 overflow-y-auto p-4 md:grid-cols-2 md:p-6 xl:grid-cols-3">
                {visibleAgentTasks.length === 0 ? (
                  <div className="col-span-full flex h-full min-h-48 items-center justify-center text-center">
                    <div className="max-w-lg">
                      <p className="text-[20px] font-semibold text-white/80">Nothing running yet</p>
                      <p className="mt-2 text-[16px] leading-relaxed text-white/45">Ask {callAgent.display_name} to compose an email, prepare a report, research something or review a document. The work will take over this screen.</p>
                    </div>
                  </div>
                ) : visibleAgentTasks.map((task) => (
                  <AgentTaskCard key={task.id} task={task} dark onAction={handleTaskAction} />
                ))}
              </div>
            </section>
            <section className="shrink-0 border-t border-white/10 bg-black/20" aria-label="Call captions">
              <button
                type="button"
                onClick={() => setCallTranscriptExpanded((expanded) => !expanded)}
                aria-expanded={callTranscriptExpanded}
                className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left md:px-6"
              >
                <span className="shrink-0 text-[11px] font-semibold uppercase tracking-[0.14em] text-sand">Captions</span>
                <span className="min-w-0 flex-1 truncate text-caption text-white/45">
                  {interim || latestCallTranscript?.text || (callState === "connecting" ? "Connecting…" : "Optional live transcript")}
                </span>
                <span aria-hidden className="shrink-0 text-white/45">{callTranscriptExpanded ? "⌄" : "⌃"}</span>
              </button>
              {callTranscriptExpanded && (
                <div
                  ref={callTranscriptScrollerRef}
                  onScroll={(event) => {
                    const target = event.currentTarget;
                    callTranscriptStickRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 100;
                  }}
                  className="max-h-[28vh] space-y-2 overflow-y-auto border-t border-white/10 px-4 py-3 md:px-6"
                >
                  {callTranscript.map((entry) => (
                    <div key={entry.id} className={clsx("flex", entry.speaker === "user" ? "justify-end" : "justify-start") }>
                      <div className={clsx(
                        "max-w-[88%] rounded-xl px-3 py-2 md:max-w-[65%]",
                        entry.speaker === "user" ? "bg-white text-nearblack" : entry.speaker === "system" ? "border border-sand/30 bg-sand/10 text-white" : "bg-white/10 text-white",
                        !entry.final && "opacity-65",
                      )}>
                        <p className={clsx("text-[11px] font-semibold uppercase tracking-[0.12em]", entry.speaker === "user" ? "text-charcoal/45" : "text-sand") }>
                          {entry.speaker === "user" ? "You" : entry.speaker === "agent" ? callAgent.display_name : "Agent work"}
                        </p>
                        <p className="mt-0.5 whitespace-pre-wrap text-caption leading-relaxed">{entry.text}</p>
                      </div>
                    </div>
                  ))}
                  {interim && !callTranscript.some((entry) => entry.id === "legacy-user-live") && (
                    <div className="flex justify-end"><p className="max-w-[88%] rounded-xl bg-white/70 px-3 py-2 text-caption text-nearblack">{interim}</p></div>
                  )}
                </div>
              )}
            </section>
          </main>
          {callError ? (
            <div className={clsx("shrink-0 grid-cols-2 border-t border-white/10 pb-[env(safe-area-inset-bottom)]", drawer && callCompact ? "grid md:hidden" : "grid")}>
              <button onClick={() => void endCall()} className="border-r border-white/10 px-3 py-5 text-subhead text-white/75">Back to chat</button>
              <button onClick={() => void retryCall()} className="bg-sand px-3 py-5 text-subhead text-nearblack">Try again</button>
            </div>
          ) : (
            <div className={clsx("shrink-0 grid-cols-3 border-t border-white/10 pb-[env(safe-area-inset-bottom)]", drawer && callCompact ? "grid md:hidden" : "grid")}>
              <button onClick={toggleMute} className="border-r border-white/10 px-3 py-4 text-subhead md:py-6"><span className="block text-xl">{muted ? "×" : "●"}</span><span className="mt-2 block text-caption text-white/55">{muted ? "Unmute" : "Mute"}</span></button>
              <button onClick={repeatLastReply} disabled={!lastSpoken} className="border-r border-white/10 px-3 py-4 text-subhead disabled:opacity-30 md:py-6"><span className="block text-xl">↻</span><span className="mt-2 block text-caption text-white/55">Repeat</span></button>
              <button onClick={() => void endCall()} className="bg-[#8e2f2f] px-3 py-4 text-subhead md:py-6"><span className="block text-xl">■</span><span className="mt-2 block text-caption text-white/70">End call</span></button>
            </div>
          )}
        </div>
      )}
      {meetingModeOpen && selectedId && callAgent?.agent_slug === "aria" && (
        <MeetingMode
          conversationId={selectedId}
          initialMeetingId={meetingMinutesId}
          sourceCallId={meetingSourceCallId}
          onClose={() => {
            setMeetingModeOpen(false);
            setMeetingSourceCallId(null);
            setMeetingMinutesId(null);
          }}
          onFiled={() => {
            void loadMessages(selectedId);
            void loadConversations({ preserveError: true });
          }}
        />
      )}
    </div>
  );
}
