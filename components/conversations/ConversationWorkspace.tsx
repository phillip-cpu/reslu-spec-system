"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { initials } from "@/lib/conversations";
import { isFatalSpeechRecognitionError, speechRecognitionErrorMessage } from "@/lib/conversation-voice";
import type {
  AgentSlug,
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
  const [error, setError] = useState<string | null>(null);
  const [callId, setCallId] = useState<string | null>(null);
  const [callOpening, setCallOpening] = useState(false);
  const [callState, setCallState] = useState<CallState>("connecting");
  const [muted, setMuted] = useState(false);
  const [interim, setInterim] = useState("");
  const [callError, setCallError] = useState<string | null>(null);
  const [lastSpoken, setLastSpoken] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recognitionPausedRef = useRef(false);
  const callIdRef = useRef<string | null>(null);
  const callActiveRef = useRef(false);
  const mutedRef = useRef(false);
  const spokenIdsRef = useRef(new Set<string>());

  const selectedConversation = useMemo(
    () => data.conversations.find((conversation) => conversation.id === selectedId) ?? null,
    [data.conversations, selectedId]
  );
  const callAgent = participants.find((participant) => participant.type === "agent") ?? null;

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
      if (callActiveRef.current) {
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
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);
  useEffect(() => { mutedRef.current = muted; }, [muted]);
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

  const sendMessage = useCallback(async (body: string, source: "text" | "voice" = "text", targetAgent?: AgentSlug) => {
    if (!selectedId || !body.trim()) return;
    setSending(true);
    if (source === "voice") setCallState("thinking");
    try {
      const response = await fetch(`/api/conversations/${selectedId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, source, target_agent_slugs: targetAgent ? [targetAgent] : undefined }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not send message");
      const queueWarning = result.queue_error
        ? `Message saved, but ${targetAgent ? targetAgent[0].toUpperCase() + targetAgent.slice(1) : "the agent"} could not be notified. Please try again shortly.`
        : null;
      setDraft("");
      setInterim("");
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

  const endCall = useCallback(async () => {
    callActiveRef.current = false;
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
  }, [selectedId, loadMessages]);

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

  async function startCall() {
    if (!selectedId || !callAgent) return;
    setCallError(null);
    setCallOpening(true);
    setCallState("connecting");
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

      const response = await fetch(`/api/conversations/${selectedId}/calls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presentation: window.innerWidth < 700 ? "driving" : "office" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Could not start call");
      if (!callActiveRef.current) {
        await fetch(`/api/conversations/${selectedId}/calls`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ call_id: body.call.id }),
        }).catch(() => null);
        return;
      }
      callIdRef.current = body.call.id;
      setCallId(body.call.id);
      setCallOpening(false);
    } catch (reason) {
      callActiveRef.current = false;
      recognitionRef.current?.abort();
      recognitionRef.current = null;
      setCallOpening(false);
      const message = reason instanceof Error ? reason.message : "Could not start call";
      setCallError(reason instanceof DOMException ? speechRecognitionErrorMessage(reason.name) : message);
    }
  }

  function toggleMute() {
    setMuted((value) => {
      const next = !value;
      if (next) recognitionRef.current?.stop();
      else if (callActiveRef.current) { try { recognitionRef.current?.start(); } catch { /* already active */ } }
      return next;
    });
  }

  function submitDraft(event: FormEvent) {
    event.preventDefault();
    void sendMessage(draft);
  }

  if (loading) return <div className="flex h-[70vh] items-center justify-center text-body text-charcoal/50">Loading conversations…</div>;

  return (
    <div
      ref={workspaceRef}
      className="relative flex h-[calc(var(--conversation-vh,100dvh)-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-0 min-w-0 overflow-hidden border border-[#d4cbbd] bg-[#f5f1e8] md:h-[calc(100vh-7.5rem)] md:min-h-[560px]"
    >
      <aside className={clsx("w-full shrink-0 border-r border-[#d4cbbd] bg-[#ede8de] md:w-80", selectedId && "hidden md:block")}>
        <div className="flex items-center justify-between border-b border-[#d4cbbd] py-3 pl-20 pr-3 md:p-4">
          <p className="label-caps">Conversations</p>
          <button onClick={() => setNewOpen(true)} className="bg-nearblack px-3 py-2 text-caption text-white">New chat</button>
        </div>
        {data.conversations.length === 0 ? (
          <div className="p-6 text-body text-charcoal/60">
            <p>No conversations yet.</p>
            <button onClick={() => setNewOpen(true)} className="mt-4 border-b border-charcoal text-nearblack">Start with Aria, Marco or a teammate</button>
          </div>
        ) : (
          <div className="overflow-y-auto">
            {data.conversations.map((conversation) => (
              <button key={conversation.id} onClick={() => setSelectedId(conversation.id)} className={clsx("flex w-full gap-3 border-b border-[#dcd6cc] p-4 text-left", selectedId === conversation.id ? "bg-[#f5f1e8]" : "hover:bg-white/30")}>
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
            <header className="flex min-h-16 items-center gap-2 border-b border-[#d4cbbd] bg-[#f5f1e8] py-2 pl-20 pr-3 md:min-h-20 md:gap-3 md:px-4 md:py-3">
              <button onClick={() => setSelectedId(null)} className="mr-1 text-charcoal/60 md:hidden" aria-label="Back to conversations">←</button>
              <div className="min-w-0 flex-1">
                <h2 className="truncate font-display text-subhead text-nearblack">{selectedConversation.display_title}</h2>
                <p className="mt-1 truncate text-caption text-charcoal/50">{participants.map((participant) => participant.display_name).join(", ")}</p>
              </div>
              {callAgent && (
                <button onClick={() => void startCall()} aria-label={`Call ${callAgent.display_name}`} className="flex shrink-0 items-center gap-2 border border-nearblack px-3 py-2 text-subhead text-nearblack hover:bg-nearblack hover:text-white md:px-4">
                  <span aria-hidden>●</span> <span className="hidden sm:inline">Call {callAgent.display_name}</span>
                </button>
              )}
            </header>

            <div className="flex-1 overflow-y-auto bg-[#faf7f0] px-4 py-6 md:px-8">
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
                        {message.metadata.source === "voice" && <p className={clsx("mt-2 text-[9px] uppercase tracking-widest", own ? "text-white/40" : "text-charcoal/35")}>Voice transcript</p>}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>
            </div>

            <form onSubmit={submitDraft} className="shrink-0 border-t border-[#d4cbbd] bg-[#f5f1e8] p-3 md:p-4">
              <div className="mx-auto flex max-w-3xl items-end gap-2">
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (draft.trim()) void sendMessage(draft); } }} rows={1} placeholder={participants.some((p) => p.type === "agent") && participants.length > 2 ? "Message the group — use @Aria or @Marco to ask an agent" : "Write a message…"} className="max-h-36 min-h-12 min-w-0 flex-1 resize-none border border-[#cfc6b8] bg-white px-3 py-3 text-body outline-none focus:border-nearblack md:px-4" />
                <button disabled={sending || !draft.trim()} className="h-12 shrink-0 bg-nearblack px-4 text-subhead text-white disabled:opacity-30 md:px-5">Send</button>
              </div>
              {error && <p className="mx-auto mt-2 max-w-3xl text-caption text-red-700">{error}</p>}
            </form>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-body text-charcoal/45">Choose a conversation or start a new one.</div>
        )}
      </section>

      {newOpen && <NewConversation people={data.people} onClose={() => setNewOpen(false)} onCreated={(id) => { setNewOpen(false); setSelectedId(id); void loadConversations(); }} />}

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
            <p className="mt-3 text-subhead uppercase tracking-[0.24em] text-sand">{callError ?? callState}</p>
            <p className="mt-5 min-h-12 max-w-xl text-body text-white/60 md:mt-8 md:min-h-16">{interim ? `“${interim}”` : callState === "listening" ? "I’m listening." : callState === "thinking" ? `${callAgent.display_name} is checking that…` : ""}</p>
          </div>
          <div className="grid shrink-0 grid-cols-3 border-t border-white/10 pb-[env(safe-area-inset-bottom)]">
            <button onClick={toggleMute} className="border-r border-white/10 px-3 py-4 text-subhead md:py-6"><span className="block text-xl">{muted ? "×" : "●"}</span><span className="mt-2 block text-caption text-white/55">{muted ? "Unmute" : "Mute"}</span></button>
            <button onClick={() => lastSpoken && speak(lastSpoken)} disabled={!lastSpoken} className="border-r border-white/10 px-3 py-4 text-subhead disabled:opacity-30 md:py-6"><span className="block text-xl">↻</span><span className="mt-2 block text-caption text-white/55">Repeat</span></button>
            <button onClick={() => void endCall()} className="bg-[#8e2f2f] px-3 py-4 text-subhead md:py-6"><span className="block text-xl">■</span><span className="mt-2 block text-caption text-white/70">End call</span></button>
          </div>
        </div>
      )}
    </div>
  );
}
