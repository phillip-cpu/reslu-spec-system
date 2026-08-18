"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";
import { boundedFetch, BoundedRequestTimeoutError } from "@/lib/bounded-request";

const PROJECT_CONVERSATION_OPEN_TIMEOUT_MS = 15_000;

export function ProjectConversationWorkspace({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [conversation, setConversation] = useState<{ projectId: string; id: string } | null>(null);
  const [failure, setFailure] = useState<{ projectId: string; message: string } | null>(null);
  const [openAttempt, setOpenAttempt] = useState(0);
  const createIntentRef = useRef<{ projectId: string; id: string } | null>(null);
  const conversationId = conversation?.projectId === projectId ? conversation.id : null;
  const error = failure?.projectId === projectId ? failure.message : null;

  useEffect(() => {
    const controller = new AbortController();
    if (createIntentRef.current?.projectId !== projectId) {
      createIntentRef.current = { projectId, id: crypto.randomUUID() };
    }
    const clientConversationId = createIntentRef.current.id;
    void boundedFetch("/api/conversations/scoped", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_kind: "project",
        scope_id: projectId,
        purpose_key: "general",
        title: `${projectName} · General`,
        agent_slug: "aria",
        client_conversation_id: clientConversationId,
      }),
      signal: controller.signal,
    }, PROJECT_CONVERSATION_OPEN_TIMEOUT_MS).then(async (response) => {
      const body = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Could not open the project conversation");
      setConversation({ projectId, id: body.id });
      setFailure(null);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setFailure({
        projectId,
        message: !navigator.onLine
          ? "This project chat is waiting for a connection. It will retry when you are online."
          : reason instanceof BoundedRequestTimeoutError
            ? "Opening this project chat took too long. Check the connection and try again."
            : reason instanceof Error ? reason.message : "Could not open the project conversation"
      });
    });
    return () => controller.abort();
  }, [openAttempt, projectId, projectName]);

  useEffect(() => {
    if (!error) return;
    const retryWhenOnline = () => {
      setFailure(null);
      setOpenAttempt((attempt) => attempt + 1);
    };
    window.addEventListener("online", retryWhenOnline, { once: true });
    return () => window.removeEventListener("online", retryWhenOnline);
  }, [error]);

  if (error) {
    return (
      <div className="border border-red-300 bg-red-50 p-6 text-[16px] leading-relaxed text-red-800" role="alert">
        <p>{error}</p>
        <button
          type="button"
          onClick={() => {
            setFailure(null);
            setOpenAttempt((attempt) => attempt + 1);
          }}
          className="mt-4 min-h-11 bg-nearblack px-5 py-2 text-[15px] font-medium text-white"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!conversationId) {
    return <div className="flex min-h-[50vh] items-center justify-center text-[16px] text-charcoal/70" role="status" aria-live="polite">Opening {projectName} conversations…</div>;
  }
  return (
    <ConversationWorkspace
      initialConversationId={conversationId}
      scope={{ kind: "project", id: projectId, label: projectName }}
    />
  );
}
