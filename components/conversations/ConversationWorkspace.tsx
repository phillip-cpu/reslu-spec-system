"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import Image from "next/image";
import { initials } from "@/lib/conversations";
import {
  conversationAttachmentKind,
  isConversationAttachmentMime,
  MAX_CONVERSATION_ATTACHMENTS,
  MAX_CONVERSATION_ATTACHMENT_BYTES,
} from "@/lib/conversation-attachments";
import { isFatalSpeechRecognitionError, speechRecognitionErrorMessage } from "@/lib/conversation-voice";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient as createBrowserClient } from "@/lib/supabase/client";
import type {
  AgentSlug,
  ConversationAttachment,
  ConversationMessage,
  ConversationParticipant,
  ConversationSummary,
  ConversationsResponse,
} from "@/types/conversations";

type CallState = "connecting" | "listening" | "thinking" | "speaking" | "interrupted" | "reconnecting";

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
}

interface DraftAttachment {
  localId: string;
  conversationId: string;
  file: File;
  filename: string;
  mimeType: string;
  byteSize: number;
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  stagedAttachmentId: string | null;
  attachment: ConversationAttachment | null;
  error: string | null;
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

function NewConversation({ people, onCreated, onClose }: {
  people: ConversationParticipant[];
  onCreated: (id: string) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = people.filter((person) => !person.is_self);

  async function createConversation(event: FormEvent) {
    event.preventDefault();
    if (selected.length === 0) return;
    setSaving(true);
    setError(null);
    const profileIds = selected.filter((key) => key.startsWith("human:")).map((key) => key.slice(6));
    const agentSlugs = selected.filter((key) => key.startsWith("agent:")).map((key) => key.slice(6)) as AgentSlug[];
    try {
      const response = await fetch("/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile_ids: profileIds, agent_slugs: agentSlugs, title }),
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [participants, setParticipants] = useState<ConversationParticipant[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [draftAttachments, setDraftAttachments] = useState<DraftAttachment[]>([]);
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
  const cancelledDraftIdsRef = useRef(new Set<string>());
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionPausedRef = useRef(false);
  const callIdRef = useRef<string | null>(null);
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

  const selectedConversation = useMemo(
    () => data.conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [data.conversations, selectedId]
  );
  const attachmentUploadInProgress = draftAttachments.some((item) => item.status === "uploading");
  const attachmentUploadFailed = draftAttachments.some((item) => item.status === "error");
  const composerBusy = sending || attachmentUploadInProgress;
  const callAgent = participants.find((participant) => participant.type === "agent") ?? null;
  const headerParticipant = callAgent
    ?? selectedConversation?.participants.find((participant) => !participant.is_self)
    ?? selectedConversation?.participants[0]
    ?? null;

  const loadConversations = useCallback(async () => {
    try {
      const response = await fetch("/api/conversations", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load conversations");
      setData(body);
      setSelectedId((current) => current ?? body.conversations[0]?.id ?? null);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load conversations");
    } finally {
      setLoading(false);
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

  const loadMessages = useCallback(async (conversationId: string) => {
    try {
      const response = await fetch(`/api/conversations/${conversationId}/messages`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not load messages");
      const incoming = body.messages as ConversationMessage[];
      setMessages(incoming);
      setParticipants(body.participants);
      if (callActiveRef.current && !realtimeActiveRef.current) {
        const unsaid = incoming.filter((message) => message.author.type === "agent" && !spokenIdsRef.current.has(message.id));
        incoming.forEach((message) => spokenIdsRef.current.add(message.id));
        const newest = unsaid.at(-1);
        if (newest) speak(newest.body);
      } else {
        incoming.forEach((message) => spokenIdsRef.current.add(message.id));
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load messages");
    }
  }, [speak]);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadConversations(), 0);
    return () => window.clearTimeout(initial);
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
      if (document.visibilityState === "visible") void loadMessages(selectedId);
    };
    window.addEventListener("focus", refreshVisibleConversation);
    window.addEventListener("online", refreshVisibleConversation);
    document.addEventListener("visibilitychange", refreshVisibleConversation);
    return () => {
      window.removeEventListener("focus", refreshVisibleConversation);
      window.removeEventListener("online", refreshVisibleConversation);
      document.removeEventListener("visibilitychange", refreshVisibleConversation);
    };
  }, [selectedId, loadMessages]);
  useEffect(() => {
    // scrollIntoView() may move the page itself on iOS, taking the chat header
    // and call action off-screen. Scroll only the message pane so the mobile
    // conversation chrome stays pinned like a native messenger.
    const scroller = messagesScrollerRef.current;
    if (scroller && shouldStickToBottomRef.current) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: "smooth" });
    }
  }, [messages]);
  useEffect(() => { shouldStickToBottomRef.current = true; }, [selectedId]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { draftAttachmentsRef.current = draftAttachments; }, [draftAttachments]);
  useEffect(() => () => {
    draftAttachmentsRef.current.forEach((item) => {
      if (item.status === "uploading") cancelledDraftIdsRef.current.add(item.localId);
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      const attachmentId = item.attachment?.id ?? item.stagedAttachmentId;
      if (attachmentId) {
        void fetch(
          `/api/conversations/${item.conversationId}/attachments?attachment_id=${encodeURIComponent(attachmentId)}`,
          { method: "DELETE", keepalive: true }
        ).catch(() => null);
      }
    });
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
    const draft = draftAttachments.find((item) => item.localId === localId);
    if (!draft) return;
    if (draft.status === "uploading") cancelledDraftIdsRef.current.add(localId);
    if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
    setDraftAttachments((current) => current.filter((item) => item.localId !== localId));
    const attachmentId = draft.attachment?.id ?? draft.stagedAttachmentId;
    if (attachmentId) {
      void fetch(
        `/api/conversations/${draft.conversationId}/attachments?attachment_id=${encodeURIComponent(attachmentId)}`,
        { method: "DELETE" }
      ).catch(() => null);
    }
  }, [draftAttachments]);

  const discardDraftAttachments = useCallback(() => {
    for (const draft of draftAttachments) {
      if (draft.status === "uploading") cancelledDraftIdsRef.current.add(draft.localId);
      if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
      const attachmentId = draft.attachment?.id ?? draft.stagedAttachmentId;
      if (attachmentId) {
        void fetch(
          `/api/conversations/${draft.conversationId}/attachments?attachment_id=${encodeURIComponent(attachmentId)}`,
          { method: "DELETE" }
        ).catch(() => null);
      }
    }
    setDraftAttachments([]);
    setAttachmentMenuOpen(false);
  }, [draftAttachments]);

  const selectConversation = useCallback((conversationId: string | null) => {
    if (conversationId === selectedId) return;
    if (sending) {
      setError("Wait for the message to finish sending before changing chats.");
      return;
    }
    discardDraftAttachments();
    setDraft("");
    setError(null);
    setSelectedId(conversationId);
  }, [discardDraftAttachments, selectedId, sending]);

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
      if (!isConversationAttachmentMime(draft.mimeType)) {
        throw new Error("Choose a JPEG, PNG, WebP or PDF file.");
      }
      if (file.size <= 0 || file.size > MAX_CONVERSATION_ATTACHMENT_BYTES) {
        throw new Error("Attachments must be no larger than 25 MB.");
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
      setDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? { ...item, stagedAttachmentId }
        : item));
      if (await discardIfCancelled()) return;

      const supabase = createBrowserClient();
      const { error: uploadError } = await supabase.storage
        .from(ASSET_BUCKET)
        .uploadToSignedUrl(urlBody.path, urlBody.token, file, { contentType: draft.mimeType });
      if (uploadError) throw new Error(uploadError.message);
      if (await discardIfCancelled()) return;

      const finalResponse = await fetch(`/api/conversations/${conversationId}/attachments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachment_id: stagedAttachmentId }),
      });
      const finalBody = await finalResponse.json();
      if (!finalResponse.ok) throw new Error(finalBody.error ?? "Could not finish upload");
      if (await discardIfCancelled()) return;
      setDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "ready",
            stagedAttachmentId: null,
            attachment: finalBody.attachment,
            error: null,
          }
        : item));
    } catch (reason) {
      if (await discardIfCancelled()) return;
      if (stagedAttachmentId) {
        await fetch(
          `/api/conversations/${conversationId}/attachments?attachment_id=${encodeURIComponent(stagedAttachmentId)}`,
          { method: "DELETE" }
        ).catch(() => null);
      }
      setDraftAttachments((current) => current.map((item) => item.localId === draft.localId
        ? {
            ...item,
            status: "error",
            stagedAttachmentId: null,
            attachment: null,
            error: reason instanceof Error ? reason.message : "Upload failed",
          }
        : item));
    }
  }, []);

  const retryDraftAttachment = useCallback((localId: string) => {
    const failed = draftAttachments.find((item) => item.localId === localId && item.status === "error");
    if (!failed) return;
    const retrying: DraftAttachment = {
      ...failed,
      status: "uploading",
      stagedAttachmentId: null,
      attachment: null,
      error: null,
    };
    setError(null);
    setDraftAttachments((current) => current.map((item) => item.localId === localId ? retrying : item));
    void uploadDraftAttachment(retrying);
  }, [draftAttachments, uploadDraftAttachment]);

  const uploadSelectedFiles = useCallback(async (selectedFiles: FileList | null) => {
    if (!selectedId || !selectedFiles?.length) return;
    const conversationId = selectedId;
    const availableSlots = MAX_CONVERSATION_ATTACHMENTS - draftAttachments.length;
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
        status: "uploading",
        stagedAttachmentId: null,
        attachment: null,
        error: null,
      };
    });
    setDraftAttachments((current) => [...current, ...drafts]);
    setAttachmentMenuOpen(false);
    await Promise.all(drafts.map(uploadDraftAttachment));
  }, [draftAttachments.length, selectedId, uploadDraftAttachment]);

  const sendMessage = useCallback(async (
    body: string,
    source: "text" | "voice" = "text",
    targetAgent?: AgentSlug,
    attachmentIds: string[] = []
  ) => {
    if (!selectedId || (!body.trim() && attachmentIds.length === 0)) return;
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
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send message");
      const queueWarning = result.queue_error
        ? `Message saved, but ${targetAgent ? targetAgent[0].toUpperCase() + targetAgent.slice(1) : "the agent"} could not be notified. Please try again shortly.`
        : null;
      setDraft("");
      setInterim("");
      if (attachmentIds.length > 0) {
        draftAttachmentsRef.current = [];
        setDraftAttachments((current) => {
          current.forEach((item) => item.previewUrl && URL.revokeObjectURL(item.previewUrl));
          return [];
        });
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
  }, [selectedId, loadMessages, loadConversations]);

  const sendRealtimeEvent = useCallback((event: Record<string, unknown>) => {
    const channel = dataChannelRef.current;
    if (channel?.readyState === "open") channel.send(JSON.stringify(event));
  }, []);

  const interruptRealtimePlayback = useCallback(() => {
    const responseId = activeResponseIdRef.current;
    if (responseId) cancelledResponseIdsRef.current.add(responseId);
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

  const endCall = useCallback(async () => {
    callActiveRef.current = false;
    realtimeActiveRef.current = false;
    cancelActiveRealtimeTurn();
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
    callIdRef.current = null;
    if (selectedId && activeCallId) {
      await fetch(`/api/conversations/${selectedId}/calls`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call_id: activeCallId }),
      }).catch(() => null);
      await loadMessages(selectedId);
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
  }, [cancelActiveRealtimeTurn, selectedId, loadMessages]);

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
    let query = "";
    try {
      const parsed = JSON.parse(argumentsJson) as { query?: unknown };
      query = typeof parsed.query === "string" ? parsed.query.trim() : "";
    } catch { /* handled below */ }
    if (!query) {
      setCallError("I couldn’t understand that turn. Please say it again.");
      setCallState("listening");
      return;
    }

    // A completed newer utterance is the point at which the prior consult is
    // genuinely superseded. Abort its local poll and cancel that exact job;
    // the POST below also atomically supersedes any unfinished agent work.
    if (activeRealtimeConsultRef.current) cancelActiveRealtimeConsult();
    const abortController = new AbortController();
    activeRealtimeConsultRef.current = { toolCallId, responseId, abortController };
    setInterim(query);
    setCallState("thinking");
    try {
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
      const startBody = await start.json();
      if (!start.ok) throw new Error(startBody.error ?? "Could not consult the RESLU agent");

      while (!abortController.signal.aborted && callActiveRef.current) {
        const statusResponse = await fetch(
          `/api/conversations/${selectedId}/realtime/consult?tool_call_id=${encodeURIComponent(toolCallId)}&agent_slug=${callAgent.agent_slug}`,
          { cache: "no-store", signal: abortController.signal }
        );
        const statusBody = await statusResponse.json();
        if (!statusResponse.ok) throw new Error(statusBody.error ?? "Could not read the RESLU agent response");
        if (statusBody.status === "done" && typeof statusBody.answer === "string") {
          if (cancelledToolCallIdsRef.current.has(toolCallId) || abortController.signal.aborted) return;
          activeRealtimeConsultRef.current = null;
          setLastSpoken(statusBody.answer);
          setInterim("");
          await loadMessages(selectedId);
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
        if (statusBody.status === "cancelled") return;
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
      activeRealtimeConsultRef.current = null;
      setCallError(reason instanceof Error ? reason.message : "The RESLU agent could not answer");
      setCallState("listening");
    }
  }, [callAgent, cancelActiveRealtimeConsult, loadMessages, selectedId, sendRealtimeEvent]);

  const handleRealtimeEvent = useCallback((event: RealtimeEvent) => {
    if (event.type === "input_audio_buffer.speech_started") {
      interruptRealtimePlayback();
      setInterim("");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped") {
      setCallState("thinking");
      return;
    }
    if (event.type === "response.created" && event.response?.id) {
      activeResponseIdRef.current = event.response.id;
      if (!cancelledResponseIdsRef.current.has(event.response.id) && remoteAudioRef.current) {
        remoteAudioRef.current.muted = false;
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
        }
      }
      if (event.response.status === "completed" && !(event.response.output ?? []).some((item) => item.type === "function_call")) {
        setCallState("listening");
      }
      return;
    }
    if (event.type === "error") {
      setCallError("The realtime call hit an error. Please try again.");
    }
  }, [interruptRealtimePlayback, runRealtimeConsult]);

  const createCallRecord = useCallback(async () => {
    if (!selectedId) throw new Error("No conversation selected");
    const response = await fetch(`/api/conversations/${selectedId}/calls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ presentation: window.innerWidth < 700 ? "driving" : "office" }),
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
        await fetch(`/api/conversations/${selectedId}/calls`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ call_id: activeCallId }),
        }).catch(() => null);
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
  }, [createCallRecord, handleVoiceText, messages, selectedId]);

  async function startCall() {
    if (!selectedId || !callAgent) return;
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
    await endCall();
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
    if (attachmentUploadInProgress) {
      setError("Wait for the attachments to finish uploading.");
      return;
    }
    if (attachmentUploadFailed) {
      setError("Retry or remove every failed attachment before sending.");
      return;
    }
    const attachmentIds = draftAttachments.flatMap((item) =>
      item.status === "ready" && item.attachment ? [item.attachment.id] : []
    );
    void sendMessage(draft, "text", undefined, attachmentIds);
  }

  if (loading) return <div className="flex h-[70vh] items-center justify-center text-body text-charcoal/50">Loading conversations…</div>;

  return (
    <div
      ref={workspaceRef}
      className="fixed inset-x-0 top-[var(--conversation-vtop,0px)] z-20 flex h-[var(--conversation-vh,100dvh)] min-h-0 min-w-0 overflow-hidden border border-[#d4cbbd] bg-[#f5f1e8] md:relative md:inset-auto md:z-auto md:h-[calc(100vh-7.5rem)] md:min-h-[560px]"
    >
      <aside className={clsx("w-full shrink-0 border-r border-[#d4cbbd] bg-[#ede8de] md:w-80", selectedId && "hidden md:block")}>
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
          <div className="overflow-y-auto">
            {data.conversations.map((conversation) => (
              <button key={conversation.id} onClick={() => selectConversation(conversation.id)} disabled={sending && selectedId !== conversation.id} className={clsx("flex w-full gap-3 border-b border-[#dcd6cc] p-4 text-left disabled:opacity-40", selectedId === conversation.id ? "bg-[#f5f1e8]" : "hover:bg-white/30")}>
                <Avatar participant={conversation.participants.find((p) => !p.is_self) ?? conversation.participants[0]} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-nearblack">{conversation.display_title}</span>
                  <span className="mt-1 block truncate text-caption text-charcoal/50">{conversation.last_message?.body ?? "New conversation"}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </aside>

      <section className={clsx("min-w-0 flex-1 flex-col", selectedId ? "flex" : "hidden md:flex")}>
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
            </header>

            <div
              ref={messagesScrollerRef}
              onScroll={(event) => {
                const pane = event.currentTarget;
                shouldStickToBottomRef.current = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 96;
              }}
              className="min-h-0 flex-1 overscroll-contain overflow-y-auto bg-[#faf7f0] px-3 py-4 md:px-8 md:py-6"
            >
              {messages.length === 0 && <p className="mx-auto mt-20 max-w-sm text-center text-body text-charcoal/50">This is the beginning of the conversation. Its history will stay here for everyone in the chat.</p>}
              <div className="mx-auto max-w-3xl space-y-4">
                {messages.map((message) => {
                  const own = message.author.is_self;
                  const record = message.kind === "call_record" || message.kind === "meeting_record";
                  if (record) return (
                    <div key={message.id} className="border-y border-[#d4cbbd] py-3 text-center">
                      <p className="label-caps">{message.kind === "call_record" ? "Call completed" : "Meeting completed"}</p>
                      <p className="mt-2 text-caption text-charcoal/60">{message.body}</p>
                    </div>
                  );
                  return (
                    <div key={message.id} className={clsx("flex gap-3", own && "flex-row-reverse")}>
                      <Avatar participant={message.author} />
                      <div className={clsx("min-w-0 max-w-[78%] border px-3 py-3 md:px-4", own ? "border-nearblack bg-nearblack text-white" : "border-[#d4cbbd] bg-[#f5f1e8] text-charcoal")}>
                        <div className="flex items-baseline gap-2">
                          <span className={clsx("text-caption font-semibold", own ? "text-white" : "text-nearblack")}>{message.author.display_name}</span>
                          <span className={clsx("text-[10px]", own ? "text-white/45" : "text-charcoal/40")}>{timeLabel(message.created_at)}</span>
                        </div>
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
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <form onSubmit={submitDraft} className="shrink-0 border-t border-[#d4cbbd] bg-[#f5f1e8] px-2 pb-[calc(env(safe-area-inset-bottom)+0.5rem)] pt-2 md:p-4">
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
                {draftAttachments.length > 0 && (
                  <div className="flex gap-2 overflow-x-auto border-b border-[#e3ddd2] p-2.5">
                    {draftAttachments.map((item) => (
                      <div key={item.localId} className="relative flex w-44 shrink-0 items-center gap-2 rounded-xl border border-[#ded7cc] bg-[#faf7f0] p-2">
                        {item.previewUrl ? (
                          <Image src={item.previewUrl} alt="" width={48} height={48} unoptimized className="h-12 w-12 shrink-0 rounded-lg object-cover" />
                        ) : (
                          <span aria-hidden className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-[#e9e2d6] text-[10px] font-semibold text-charcoal">PDF</span>
                        )}
                        <div className="min-w-0 flex-1 pr-4">
                          <span className="block truncate text-caption font-semibold text-nearblack">{item.filename}</span>
                          <span className={clsx("mt-1 block truncate text-[10px]", item.status === "error" ? "text-red-700" : "text-charcoal/50")}>
                            {item.status === "uploading" ? "Uploading…" : item.status === "error" ? item.error : fileSizeLabel(item.byteSize)}
                          </span>
                          {item.status === "error" && (
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
                          aria-label={item.status === "uploading" ? `Cancel upload of ${item.filename}` : `Remove ${item.filename}`}
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
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onFocus={() => setAttachmentMenuOpen(false)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={1}
                  placeholder={participants.some((p) => p.type === "agent") && participants.length > 2 ? "Message the group — use @Aria or @Marco" : `Message ${callAgent?.display_name ?? "the conversation"}`}
                  className="max-h-36 min-h-12 w-full resize-none rounded-t-2xl bg-transparent px-4 pb-2 pt-3 text-body outline-none"
                />
                <div className="flex items-center justify-between gap-3 px-2.5 pb-2.5">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setAttachmentMenuOpen((open) => !open)}
                      aria-label="Add photos or files"
                      aria-expanded={attachmentMenuOpen}
                      className="flex h-10 w-10 items-center justify-center rounded-full border border-[#d7d0c5] text-xl text-nearblack hover:bg-[#f1ece3]"
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

      {newOpen && <NewConversation people={data.people} onClose={() => setNewOpen(false)} onCreated={(id) => { discardDraftAttachments(); setDraft(""); setNewOpen(false); setSelectedId(id); void loadConversations(); }} />}

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
