"use client";

import { useEffect, useState } from "react";
import type { ConversationAgentActivity, ConversationParticipant } from "@/types/conversations";

export function ChatProgress({ activities, participants, onDetails }: {
  activities: ConversationAgentActivity[]; participants: ConversationParticipant[]; onDetails: () => void;
}) {
  const [now, setNow] = useState<number | null>(null);
  const running = activities.length > 0;
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!activities.length) return null;
  return <div className="chat-progress" aria-label="Current agent activity">
    {activities.map(activity => {
      const name = participants.find(person => person.id === activity.agent_id)?.display_name ?? "Agent";
      const start = Date.parse(activity.claimed_at ?? activity.queued_at);
      const elapsed = now && Number.isFinite(start) ? Math.max(0, Math.floor((now - start) / 1000)) : 0;
      const stale = elapsed > 120 && (!activity.progress_updated_at || (now ?? 0) - Date.parse(activity.progress_updated_at) > 120000);
      return <div key={activity.agent_id} className="chat-progress-row">
        <span aria-hidden className={stale ? "chat-status-dot chat-status-delayed" : "chat-status-dot"} />
        <div className="chat-progress-copy"><p role="status">{stale ? `${name} is taking longer than expected` : `${name} · ${activity.status === "pending" ? "Waiting to start" : activity.progress_label ?? "Working on your request"}`}</p>
          {stale && <span>No recent progress update. Check activity before retrying.</span>}
        </div>
        {elapsed > 0 && <time aria-label={`${elapsed} seconds elapsed`}>{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</time>}
      </div>;
    })}
    <button type="button" onClick={onDetails}>View activity</button>
  </div>;
}
