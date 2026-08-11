"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import { initials } from "@/lib/conversations";
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
import type {
  AgentSlug,
  ConversationAgentActivity,
  ConversationAttachment,
  ConversationMessage,
  ConversationParticipant,
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
    output?: Array<{
      type?: string;
      name?: string;
      call_id?: string;
      arguments?: string;
      content?: Array<{ transcript?: string }>;
    }>;
  };
}

interface ActiveRealtimeConsult {
  toolCallId: string;
  responseId: string | null;
  abortController: AbortController;
  progressTimer: number | null;
  progressCuePlayed: boolean;
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
      <form onSubmit={createConversation} className="max-h-full w-full max-w-lg overflow-y-auto border border-[#d4cbbd] bg-[#f5f1e8] p-4 shadow-2xl md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="label-caps">New conversation</p>
            <h2 className="mt-2 font-display text-section text-nearblack">Who’s in this chat?</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-charcoal/50 hover:text-charcoal">✕</button>
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

export function ConversationWorkspace() {
  const [data, setData] = useState<ConversationsResponse>({ conversations: [], people: [] });
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
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
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
  const [attachmentDropActive, setAttachmentDropActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [callOpening, setCallOpening] = useState(false);
  const [callState, setCallState] = useState<CallState>("connecting");
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [callError, setCallError] = useState<string | null>(null);
  const [lastSpoken, setLastSpoken] = useState("");
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
  const realtimeActiveRef = useRef(false);
  const activeResponseIdRef = useRef<string | null>(null);
  const activeRealtimeConsultRef = useRef<ActiveRealtimeConsult | null>(null);
  const cancelledResponseIdsRef = useRef(new Set<string>());
  const cancelledToolCallIdsRef = useRef(new Set<string>());
  const handledToolCallIdsRef = useRef(new Set<string>());
  const lastRealtimeSpeechStoppedAtRef = useRef<number | null>(null);
  const realtimeTurnSequenceRef = useRef(0);
  const realtimeTurnTimingsRef = useRef(new Map<string, RealtimeTurnTiming>());
  const realtimeResponseToolCallIdsRef = useRef(new Map<string, string>());
  const realtimeProgressResponseToolCallIdsRef = useRef(new Map<string, string>());
  const pendingSpokenToolCallIdRef = useRef<string | null>(null);
  const pendingProgressToolCallIdRef = useRef<string | null>(null);
  const lastReadMessageByConversationRef = useRef(new Map<string, string>());
  const messageSearchRequestRef = useRef(0);
  const conversationListRequestRef = useRef(0);
  const messageRequestSequenceRef = useRef(0);
  const activeMessageRequestRef = useRef(new Map<string, number>());

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
  const composerBusy = sending || attachmentUploadInProgress;
  const callAgent = participants.find((participant) => participant.type === "agent") ?? null;
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
    if (document.visibilityState !== "visible") return;
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
      const requestedMessage = requestedMessageIdRef.current
        ? incoming.find((message) => message.id === requestedMessageIdRef.current)
        : null;
      const readThroughMessage = requestedMessage ?? (shouldStickToBottomRef.current ? incoming.at(-1) : null);
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
    messageSearchRequestRef.current += 1;
    if (selectedId) activeMessageRequestRef.current.delete(selectedId);
    if (conversationId) activeMessageRequestRef.current.delete(conversationId);
    setMessageSearch({ query: "", results: [], loading: false, error: null, hasSearched: false });
    selectedIdRef.current = conversationId;
    setMessages([]);
    setParticipants([]);
    setAgentActivity([]);
    setConversationMenuOpen(false);
    setSelectedId(conversationId);
  }, [selectedId, sending]);

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
        throw new Error("Choose a JPEG, PNG, WebP or PDF file.");
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
    const messageBody = body.trim() || `Shared ${attachments.length} attachment${attachments.length === 1 ? "" : "s"}`;
    const createdAtMs = Math.max(Date.now(), lastOutboxCreatedAtMsRef.current + 1);
    lastOutboxCreatedAtMsRef.current = createdAtMs;
    const entry: PendingConversationMessage = {
      clientMessageId: crypto.randomUUID(),
      ownerProfileId,
      conversationId,
      body: messageBody,
      source: "text",
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

  const interruptRealtimePlayback = useCallback(() => {
    const responseId = activeResponseIdRef.current;
    if (responseId) {
      cancelledResponseIdsRef.current.add(responseId);
      const toolCallId = realtimeResponseToolCallIdsRef.current.get(responseId);
      const timing = toolCallId ? realtimeTurnTimingsRef.current.get(toolCallId) : null;
      if (timing && timing.outcome === "pending") timing.outcome = "cancelled";
    }
    activeResponseIdRef.current = null;
    // A VAD speech-start is only evidence that playback should stop. It is
    // not yet a completed replacement request: road noise, echo and a throat
    // clear can all produce this event. Keep the authoritative OpenClaw
    // consult alive until a newer completed tool call supersedes it.
    if (responseId) {
      sendRealtimeEvent({ type: "response.cancel" });
      sendRealtimeEvent({ type: "output_audio_buffer.clear" });
    }
    if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
    setCallState("interrupted");
  }, [sendRealtimeEvent]);

  const cancelActiveRealtimeConsult = useCallback(() => {
    const consult = activeRealtimeConsultRef.current;
    if (consult) {
      cancelledToolCallIdsRef.current.add(consult.toolCallId);
      const timing = realtimeTurnTimingsRef.current.get(consult.toolCallId);
      if (timing && timing.outcome === "pending") timing.outcome = "cancelled";
      if (consult.progressTimer != null) window.clearTimeout(consult.progressTimer);
      if (pendingProgressToolCallIdRef.current === consult.toolCallId) pendingProgressToolCallIdRef.current = null;
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
    callActiveRef.current = false;
    realtimeActiveRef.current = false;
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
    activeRealtimeConsultRef.current = null;
    cancelledResponseIdsRef.current.clear();
    cancelledToolCallIdsRef.current.clear();
    handledToolCallIdsRef.current.clear();
    lastRealtimeSpeechStoppedAtRef.current = null;
    realtimeTurnSequenceRef.current = 0;
    realtimeTurnTimingsRef.current.clear();
    realtimeResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseToolCallIdsRef.current.clear();
    pendingSpokenToolCallIdRef.current = null;
    pendingProgressToolCallIdRef.current = null;
    return callRecordSaved;
  }, [cancelActiveRealtimeTurn, persistCallEnd, selectedId]);

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

  const runRealtimeConsult = useCallback(async (toolCallId: string, responseId: string | null, argumentsJson: string) => {
    if (!selectedId || !callAgent?.agent_slug || !callIdRef.current || handledToolCallIdsRef.current.has(toolCallId)) return;
    handledToolCallIdsRef.current.add(toolCallId);
    const toolCallAt = performance.now();
    const timing: RealtimeTurnTiming = {
      turn: ++realtimeTurnSequenceRef.current,
      outcome: "pending",
      speechStoppedAt: lastRealtimeSpeechStoppedAtRef.current,
      toolCallAt,
      progressRequestedAt: null,
      progressAudioAt: null,
      consultStartedAt: null,
      consultAcceptedAt: null,
      answerReadyAt: null,
      responseRequestedAt: null,
      firstAudioAt: null,
      queueWaitMs: null,
      agentProcessingMs: null,
      backendTotalMs: null,
    };
    lastRealtimeSpeechStoppedAtRef.current = null;
    realtimeTurnTimingsRef.current.set(toolCallId, timing);
    let query = "";
    try {
      const parsed = JSON.parse(argumentsJson) as { query?: unknown };
      query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    } catch { /* handled below */ }
    if (!query) {
      timing.outcome = "failed";
      setCallError("I couldn’t understand that turn. Please say it again.");
      setCallState("listening");
      return;
    }

    // A completed newer utterance is the point at which the prior consult is
    // genuinely superseded. Abort its local poll and cancel that exact job;
    // the POST below also atomically supersedes any unfinished agent work.
    if (activeRealtimeConsultRef.current) cancelActiveRealtimeConsult();
    const abortController = new AbortController();
    activeRealtimeConsultRef.current = {
      toolCallId,
      responseId,
      abortController,
      progressTimer: null,
      progressCuePlayed: false,
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
          const completedConsult = activeRealtimeConsultRef.current;
          if (completedConsult?.toolCallId === toolCallId && completedConsult.progressTimer != null) {
            window.clearTimeout(completedConsult.progressTimer);
          }
          activeRealtimeConsultRef.current = null;
          setLastSpoken(statusBody.answer);
          setInterim("");
          void loadMessages(selectedId);
          const progressResponseId = activeResponseIdRef.current;
          if (progressResponseId) {
            cancelledResponseIdsRef.current.add(progressResponseId);
            sendRealtimeEvent({ type: "response.cancel" });
            sendRealtimeEvent({ type: "output_audio_buffer.clear" });
            activeResponseIdRef.current = null;
            if (remoteAudioRef.current) remoteAudioRef.current.muted = true;
          }
          if (pendingProgressToolCallIdRef.current === toolCallId) pendingProgressToolCallIdRef.current = null;
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
          const cancelledConsult = activeRealtimeConsultRef.current;
          if (cancelledConsult?.toolCallId === toolCallId && cancelledConsult.progressTimer != null) {
            window.clearTimeout(cancelledConsult.progressTimer);
          }
          activeRealtimeConsultRef.current = null;
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
      const failedConsult = activeRealtimeConsultRef.current;
      if (failedConsult?.toolCallId === toolCallId && failedConsult.progressTimer != null) {
        window.clearTimeout(failedConsult.progressTimer);
      }
      activeRealtimeConsultRef.current = null;
      setCallError(reason instanceof Error ? reason.message : "The RESLU agent could not answer");
      setCallState("listening");
    }
  }, [callAgent, cancelActiveRealtimeConsult, loadMessages, selectedId, sendRealtimeEvent]);

  const scheduleRealtimeProgressCue = useCallback((toolCallId: string, initialResponseId: string | null) => {
    const consult = activeRealtimeConsultRef.current;
    if (!consult || consult.toolCallId !== toolCallId || consult.progressCuePlayed || consult.progressTimer != null) return;
    if (initialResponseId && consult.responseId && initialResponseId !== consult.responseId) return;
    consult.progressTimer = window.setTimeout(() => {
      const current = activeRealtimeConsultRef.current;
      if (!current || current.toolCallId !== toolCallId || !callActiveRef.current) return;
      current.progressTimer = null;
      current.progressCuePlayed = true;
      const timing = realtimeTurnTimingsRef.current.get(toolCallId);
      if (timing) timing.progressRequestedAt = performance.now();
      pendingProgressToolCallIdRef.current = toolCallId;
      sendRealtimeEvent({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          tool_choice: "none",
          instructions: 'Say exactly: "I’m checking that now."',
        },
      });
    }, 0);
  }, [sendRealtimeEvent]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "input_audio_buffer.speech_started") {
      interruptRealtimePlayback();
      setInterim("");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      lastRealtimeSpeechStoppedAtRef.current = performance.now();
      setCallState("thinking");
      return;
    }
    if (event.type === "response.created" && event.response?.id) {
      activeResponseIdRef.current = event.response.id;
      const progressToolCallId = pendingProgressToolCallIdRef.current;
      const spokenToolCallId = pendingSpokenToolCallIdRef.current;
      if (progressToolCallId) {
        realtimeProgressResponseToolCallIdsRef.current.set(event.response.id, progressToolCallId);
        pendingProgressToolCallIdRef.current = null;
      } else if (spokenToolCallId) {
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
    if (event.type === "response.output_audio_transcript.delta" && event.delta) {
      setCallState("speaking");
      setInterim((current) => `${current}${event.delta}`);
      return;
    }
    if (event.type === "response.output_audio_transcript.done" && event.transcript) {
      setLastSpoken(event.transcript);
      setInterim("");
      return;
    }
    if (event.type === "response.function_call_arguments.done" && event.call_id && event.name === "consult_reslu_agent") {
      void runRealtimeConsult(event.call_id, event.response_id ?? activeResponseIdRef.current, event.arguments ?? "{}");
      return;
    }
    if (event.type === "response.done" && event.response) {
      const responseId = event.response.id ?? activeResponseIdRef.current;
      if (responseId && cancelledResponseIdsRef.current.has(responseId)) return;
      activeResponseIdRef.current = null;
      for (const output of event.response.output ?? []) {
        if (output.type === "function_call" && output.name === "consult_reslu_agent" && output.call_id) {
          void runRealtimeConsult(output.call_id, responseId ?? null, output.arguments ?? "{}");
          scheduleRealtimeProgressCue(output.call_id, responseId ?? null);
        }
      }
      if (event.response.status === "completed" && !(event.response.output ?? []).some((item) => item.type === "function_call")) {
        setCallState(activeRealtimeConsultRef.current ? "thinking" : "listening");
      }
      return;
    }
    if (event.type === "error") {
      setCallError("The realtime call hit an error. Please try again.");
    }
  }, [interruptRealtimePlayback, runRealtimeConsult, scheduleRealtimeProgressCue]);

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

  const startRealtimeCall = useCallback(async (stream: MediaStream, activeCallId: string) => {
    if (!selectedId || !callAgent?.agent_slug) throw new Error("No RESLU agent selected");
    const peer = new RTCPeerConnection();
    const audio = document.createElement("audio");
    audio.autoplay = true;
    audio.setAttribute("playsinline", "true");
    peer.ontrack = (event) => { audio.srcObject = event.streams[0]; };
    stream.getTracks().forEach((track) => peer.addTrack(track, stream));
    const channel = peer.createDataChannel("oai-events");
    channel.onopen = () => {
      setCallOpening(false);
      setCallState("listening");
    };
    channel.onmessage = (message) => {
      try { handleRealtimeEvent(JSON.parse(message.data) as RealtimeEvent); } catch { /* ignore malformed provider events */ }
    };
    channel.onclose = () => {
      if (callActiveRef.current && realtimeActiveRef.current) setCallState("reconnecting");
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
      throw error;
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
    peerConnectionRef.current = peer;
    dataChannelRef.current = channel;
    remoteAudioRef.current = audio;
    microphoneStreamRef.current = stream;
    realtimeActiveRef.current = true;
    callActiveRef.current = true;
    callIdRef.current = activeCallId;
  }, [callAgent, handleRealtimeEvent, selectedId]);

  const startLegacyCall = useCallback(async (existingCallId?: string) => {
    const SpeechRecognition = (window as Window & { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }).SpeechRecognition
      ?? (window as Window & { webkitSpeechRecognition?: SpeechRecognitionConstructor }).webkitSpeechRecognition;
    if (!SpeechRecognition) {
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
          if (result.isFinal) handleVoiceText(result[0].transcript);
          else live += result[0].transcript;
        }
        setInterim(live);
      };
      recognition.onerror = (event) => {
        if (!callActiveRef.current || event.error === "aborted") return;
        if (isFatalSpeechRecognitionError(event.error)) {
          callActiveRef.current = false;
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
      recognition.start();
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
    } catch (reason) {
      callActiveRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setCallOpening(false);
      const message = reason instanceof Error ? reason.message : "Could not start call";
      setCallError(reason instanceof DOMException ? speechRecognitionErrorMessage(reason.name) : message);
    }
  }, [createCallRecord, handleVoiceText, messages, persistCallEnd, selectedId]);

  async function startCall() {
    if (!selectedId || !callAgent) return;
    callConversationIdRef.current ??= selectedId;
    clientCallIdRef.current ??= crypto.randomUUID();
    lastRealtimeSpeechStoppedAtRef.current = null;
    realtimeTurnSequenceRef.current = 0;
    realtimeTurnTimingsRef.current.clear();
    realtimeResponseToolCallIdsRef.current.clear();
    realtimeProgressResponseToolCallIdsRef.current.clear();
    pendingSpokenToolCallIdRef.current = null;
    pendingProgressToolCallIdRef.current = null;
    setCallError(null);
    setCallOpening(true);
    setCallState("connecting");
    callActiveRef.current = true;
    messages.forEach((message) => spokenIdsRef.current.add(message.id));

    if (!("RTCPeerConnection" in window) || !navigator.mediaDevices?.getUserMedia) {
      await startLegacyCall();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
    setMuted((value) => {
      const next = !value;
      if (realtimeActiveRef.current) {
        microphoneStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !next; });
      } else if (next) recognitionRef.current?.stop();
      else if (callActiveRef.current) { try { recognitionRef.current?.start(); } catch { /* already active */ } }
      return next;
    });
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

  if (loading) return <div className="flex h-[70vh] items-center justify-center text-body text-charcoal/50">Loading conversations…</div>;

  return (
    <div
      ref={workspaceRef}
      className="fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-20 flex h-[var(--conversation-vh,100dvh)] min-h-0 min-w-0 overflow-hidden border border-[#d4cbbd] bg-[#f5f1e8] md:relative md:inset-auto md:z-auto md:h-[calc(100vh-7.5rem)] md:min-h-[560px]"
    >
      <aside className={clsx("flex min-h-0 w-full shrink-0 flex-col border-r border-[#d4cbbd] bg-[#ede8de] md:w-80", selectedId && "hidden md:flex")}>
        <div className="flex items-center justify-between border-b border-[#d4cbbd] py-3 pl-20 pr-3 md:p-4">
          <p className="label-caps">Conversations</p>
          <button onClick={() => setNewOpen(true)} disabled={sending} className="bg-nearblack px-3 py-2 text-caption text-white disabled:opacity-30">New chat</button>
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
                  <button key={conversation.id} onClick={() => selectConversation(conversation.id)} disabled={sending && selectedId !== conversation.id} className={clsx("flex w-full gap-3 border-b border-[#dcd6cc] p-4 text-left disabled:opacity-40", selectedId === conversation.id ? "bg-[#f5f1e8]" : "hover:bg-white/30")}>
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
        className={clsx("relative min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}
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
              <button onClick={() => selectConversation(null)} disabled={sending} className="flex h-11 w-8 shrink-0 items-center justify-center text-xl text-charcoal/70 disabled:opacity-30 md:hidden" aria-label="Back to conversations">‹</button>
              {headerParticipant && <Avatar participant={headerParticipant} />}
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-subhead text-nearblack">{selectedConversation.display_title}</h2>
                <p className="mt-1 truncate text-caption text-charcoal/50">{participants.map((participant) => participant.display_name).join(", ")}</p>
              </div>
              {callAgent && (
                <button onClick={() => void startCall()} aria-label={`Call ${callAgent.display_name}`} className="flex h-11 shrink-0 items-center justify-center gap-2 border border-nearblack px-3 text-nearblack hover:bg-nearblack hover:text-white md:px-4">
                  <svg aria-hidden="true" viewBox="0 0 24 24" className="h-5 w-5 fill-none stroke-current" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M7.2 3.5 9.5 8l-2.2 1.7a15.4 15.4 0 0 0 7 7l1.7-2.2 4.5 2.3-.7 3.2c-.2.8-.9 1.4-1.8 1.4A15.5 15.5 0 0 1 2.6 6c0-.9.6-1.6 1.4-1.8l3.2-.7Z" />
                  </svg>
                  <span className="hidden text-subhead sm:inline">Call {callAgent.display_name}</span>
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

            {messageSearchOpen && (
              <div className="absolute inset-0 z-40 flex min-h-0 flex-col bg-[#f5f1e8]">
                <div className="flex min-h-16 shrink-0 items-center justify-between gap-4 border-b border-[#d4cbbd] py-3 pl-16 pr-3 md:min-h-20 md:px-5">
                  <div className="min-w-0">
                    <p className="label-caps">Search messages</p>
                    <p className="mt-1 truncate text-caption text-charcoal/50">{selectedConversation.display_title}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setMessageSearchOpen(false)}
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-lg text-charcoal/65 hover:bg-[#e9e2d6]"
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
                      placeholder="Search this conversation"
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
                    <p className="p-8 text-center text-body text-charcoal/50">No matching messages.</p>
                  )}
                  {!messageSearch.hasSearched && (
                    <p className="p-8 text-center text-body text-charcoal/50">Search the full conversation history, not just the messages currently on screen.</p>
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
                {timelineItems.map(({ message, pending }) => {
                  const own = message.author.is_self;
                  const record = message.kind === "call_record" || message.kind === "meeting_record";
                  const repliedMessage = message.reply_to_id ? timelineMessageById.get(message.reply_to_id) ?? null : null;
                  if (record) return (
                    <div key={message.id} className="border-y border-[#d4cbbd] py-3 text-center">
                      <p className="label-caps">{message.kind === "call_record" ? "Call completed" : "Meeting completed"}</p>
                      <p className="mt-2 text-caption text-charcoal/60">{message.body}</p>
                    </div>
                  );
                  return (
                    <div id={`conversation-message-${message.id}`} key={message.id} className={clsx("flex gap-3", own && "flex-row-reverse")}>
                      <Avatar participant={message.author} />
                      <div className={clsx("group relative min-w-0 max-w-[78%] border px-3 py-3 md:px-4", own ? "border-nearblack bg-nearblack text-white" : "border-[#d4cbbd] bg-[#f5f1e8] text-charcoal")}>
                        <div className="flex items-baseline gap-2">
                          <span className={clsx("text-caption font-semibold", own ? "text-white" : "text-nearblack")}>{message.author.display_name}</span>
                          <span className={clsx("text-[10px]", own ? "text-white/45" : "text-charcoal/40")}>{timeLabel(message.created_at)}</span>
                          <button
                            type="button"
                            onClick={() => setMessageMenuId((current) => current === message.id ? null : message.id)}
                            aria-label={`Actions for message from ${message.author.display_name}`}
                            aria-haspopup="menu"
                            aria-expanded={messageMenuId === message.id}
                            className={clsx("ml-auto -mr-1 flex h-7 w-7 items-center justify-center rounded-full text-[11px] tracking-widest transition-opacity focus:opacity-100 md:opacity-0 md:group-hover:opacity-100", own ? "text-white/65 hover:bg-white/10" : "text-charcoal/55 hover:bg-black/5")}
                          >
                            <span aria-hidden>•••</span>
                          </button>
                        </div>
                        {messageMenuId === message.id && (
                          <div role="menu" className="absolute right-2 top-10 z-20 w-36 overflow-hidden rounded-xl border border-[#d4cbbd] bg-white py-1 text-caption text-nearblack shadow-2xl">
                            {!pending && (
                              <button type="button" role="menuitem" onClick={() => beginReply(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                                Reply
                              </button>
                            )}
                            <button type="button" role="menuitem" onClick={() => void copyCanonicalMessage(message)} className="block w-full px-4 py-2.5 text-left hover:bg-[#f5f1e8]">
                              Copy
                            </button>
                          </div>
                        )}
                        {message.reply_to_id && (
                          <button
                            type="button"
                            onClick={() => jumpToReferencedMessage(message.reply_to_id!)}
                            className={clsx("mt-2 block w-full border-l-2 px-3 py-2 text-left", own ? "border-white/40 bg-white/10" : "border-charcoal/30 bg-white/55")}
                          >
                            <span className={clsx("block truncate text-[10px] font-semibold", own ? "text-white/65" : "text-charcoal/55")}>{repliedMessage?.author.display_name ?? "Earlier message"}</span>
                            <span className={clsx("mt-1 block truncate text-caption", own ? "text-white/80" : "text-charcoal/70")}>{repliedMessage?.body ?? "Open original message"}</span>
                          </button>
                        )}
                        <p className="mt-2 whitespace-pre-wrap text-body leading-relaxed">{message.body}</p>
                        {(message.attachments ?? []).length > 0 && (
                          <div className={clsx("mt-3 grid gap-2", message.attachments.length > 1 && "grid-cols-2")}>
                            {message.attachments.map((attachment) => {
                              const imageAttachment = conversationAttachmentKind(attachment.mime_type) === "image";
                              if (imageAttachment && attachment.url) return (
                                <a key={attachment.id} href={attachment.url} target="_blank" rel="noreferrer" className={clsx("block overflow-hidden border", own ? "border-white/15 bg-white/10" : "border-[#d4cbbd] bg-white/50")}>
                                  <Image
                                    src={attachment.url}
                                    alt={attachment.filename}
                                    width={480}
                                    height={320}
                                    unoptimized
                                    className="h-36 w-full object-cover md:h-48"
                                  />
                                  <span className="block truncate px-2 py-2 text-[10px] opacity-65">{attachment.filename}</span>
                                </a>
                              );
                              return (
                                <a key={attachment.id} href={attachment.url ?? undefined} target="_blank" rel="noreferrer" className={clsx("flex min-w-0 items-center gap-3 border px-3 py-3", own ? "border-white/15 bg-white/10" : "border-[#d4cbbd] bg-white/50", !attachment.url && "pointer-events-none opacity-50")}>
                                  <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center border border-current text-[10px] font-semibold">{imageAttachment ? "IMG" : "PDF"}</span>
                                  <span className="min-w-0">
                                    <span className="block truncate text-caption font-semibold">{attachment.filename}</span>
                                    <span className="mt-1 block text-[10px] opacity-55">{fileSizeLabel(attachment.byte_size)}</span>
                                  </span>
                                </a>
                              );
                            })}
                          </div>
                        )}
                        {message.metadata.source === "voice" && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Voice transcript</p>}
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
                          <span>{activity.status === "processing" ? "Working on your request" : "Waiting to start"}</span>
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
                    <button type="button" onClick={() => setReplyingTo(null)} aria-label="Cancel reply" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-lg text-charcoal/50 hover:bg-[#f1ece3]">
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
                            {item.mimeType.startsWith("image/") ? "IMG" : "PDF"}
                          </span>
                        )}
                        <div className="min-w-0 flex-1 pr-4">
                          <span className="block truncate text-caption font-semibold text-nearblack">{item.filename}</span>
                          <span className={clsx("mt-1 block truncate text-[10px]", item.status === "error" ? "text-red-700" : "text-charcoal/50")}>
                            {item.status === "preparing"
                              ? "Preparing…"
                              : item.status === "uploading"
                                ? "Uploading…"
                                : item.status === "error"
                                  ? item.error
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
                          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-nearblack text-[11px] text-white"
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
                  disabled={sending}
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
                  className="max-h-36 min-h-12 w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-3 text-body outline-none disabled:opacity-60"
                />
                <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
                  <div className="relative">
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => setAttachmentMenuOpen((open) => !open)}
                      aria-label="Add photos or files"
                      aria-expanded={attachmentMenuOpen}
                      className="flex h-10 w-10 items-center justify-center rounded-full border border-[#d7d0c5] text-xl text-nearblack hover:bg-[#f1ece3] disabled:opacity-40"
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
                  <span className="hidden text-[10px] text-charcoal/40 sm:block">Up to 6 files · 25 MB each</span>
                  <button
                    disabled={composerBusy || attachmentUploadFailed || (!draft.trim() && !draftAttachments.some((item) => item.status === "ready"))}
                    aria-label="Send message"
                    className="flex h-10 min-w-10 shrink-0 items-center justify-center rounded-full bg-nearblack px-3 text-subhead text-white disabled:opacity-30"
                  >
                    <span aria-hidden>↑</span><span className="sr-only">Send</span>
                  </button>
                </div>
              </div>
              {error && <p className="mx-auto mt-2 max-w-3xl text-caption text-red-700">{error}</p>}
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-body text-charcoal/45">Choose a conversation or start a new one.</div>
        )}
      </section>

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

      {(callOpening || callId || callError) && callAgent && (
        <div className="fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-[70] flex h-[var(--conversation-vh,100dvh)] min-h-0 flex-col overflow-hidden bg-nearblack text-white">
          <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)] md:px-6 md:py-5">
            <div>
              <p className="label-caps text-sand">RESLU call</p>
              <p className="mt-1 text-caption text-white/45">{selectedConversation?.display_title}</p>
            </div>
            <button onClick={() => void endCall()} className="border border-white/30 px-4 py-2 text-caption">Close</button>
          </div>
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-4 py-4 text-center md:px-6">
            <div className={clsx("relative", callState === "speaking" && "animate-pulse")}>
              <Avatar participant={callAgent} large />
              <span className={clsx("absolute -bottom-2 -right-2 h-5 w-5 border-4 border-nearblack", callState === "reconnecting" ? "bg-[#C9971E]" : "bg-[#5f895f]")} />
            </div>
            <h2 className="mt-5 font-display text-[36px] leading-none md:mt-8 md:text-[42px]">{callAgent.display_name}</h2>
            <p className={clsx("mt-3 text-subhead uppercase tracking-[0.24em]", callError ? "text-[#e28b8b]" : "text-sand")}>{callError ? "Call interrupted" : callState}</p>
            <p className="mt-5 min-h-12 max-w-xl text-body text-white/60 md:mt-8 md:min-h-16">{callError ?? (interim ? `“${interim}”` : callState === "listening" ? "I’m listening." : callState === "thinking" ? `${callAgent.display_name} is checking that…` : "")}</p>
          </div>
          {callError ? (
            <div className="grid shrink-0 grid-cols-2 border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
              <button onClick={() => void endCall()} className="border-r border-white/10 px-3 py-5 text-subhead text-white/75">Back to chat</button>
              <button onClick={() => void retryCall()} className="bg-sand px-3 py-5 text-subhead text-nearblack">Try again</button>
            </div>
          ) : (
            <div className="grid shrink-0 grid-cols-3 border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
              <button onClick={toggleMute} className="border-r border-white/10 px-3 py-4 text-subhead md:py-6"><span className="block text-xl">{muted ? "×" : "●"}</span><span className="mt-2 block text-caption text-white/55">{muted ? "Unmute" : "Mute"}</span></button>
              <button onClick={repeatLastReply} disabled={!lastSpoken} className="border-r border-white/10 px-3 py-4 text-subhead disabled:opacity-30 md:py-6"><span className="block text-xl">↻</span><span className="mt-2 block text-caption text-white/55">Repeat</span></button>
              <button onClick={() => void endCall()} className="bg-[#8e2f2f] px-3 py-4 text-subhead md:py-6"><span className="block text-xl">■</span><span className="mt-2 block text-caption text-white/70">End call</span></button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
