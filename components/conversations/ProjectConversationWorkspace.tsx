"use client";

import { useEffect, useRef, useState } from "react";
import { ConversationWorkspace } from "@/components/conversations/ConversationWorkspace";

export function ProjectConversationWorkspace({ projectId, projectName }: { projectId: string; projectName: string }) {
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const createIntentRef = useRef(crypto.randomUUID());

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/conversations/scoped", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope_kind: "project",
        scope_id: projectId,
        purpose_key: "general",
        title: `${projectName} · General`,
        agent_slug: "aria",
        client_conversation_id: createIntentRef.current,
      }),
      signal: controller.signal,
    }).then(async (response) => {
      const body = await response.json().catch(() => ({})) as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Could not open the project conversation");
      setConversationId(body.id);
    }).catch((reason) => {
      if (controller.signal.aborted) return;
      setError(reason instanceof Error ? reason.message : "Could not open the project conversation");
    });
    return () => controller.abort();
  }, [projectId, projectName]);

  if (error) {
    return <div className="border border-red-300 bg-red-50 p-6 text-[16px] leading-relaxed text-red-800">{error}</div>;
  }
  if (!conversationId) {
    return <div className="flex min-h-[50vh] items-center justify-center text-[16px] text-charcoal/55">Opening {projectName} conversations…</div>;
  }
  return (
    <ConversationWorkspace
      initialConversationId={conversationId}
      scope={{ kind: "project", id: projectId, label: projectName }}
    />
  );
}
