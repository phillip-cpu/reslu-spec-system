export type ConversationKind = "direct" | "group";
export type ConversationMessageKind = "text" | "call_record" | "meeting_record" | "system";
export type AgentSlug = "aria" | "marco" | "stuart";
export type AgentTaskStatus = "queued" | "running" | "awaiting_approval" | "completed" | "failed" | "cancelled";
export type AgentTaskModelTier = "fast" | "standard" | "strong";

export interface ConversationContext {
  scope_kind: "project" | "lead";
  scope_id: string;
  purpose_key: string;
  scope_label: string;
  summary_updated_at: string | null;
}

export interface ConversationAttachment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  uploaded_by: string;
  storage_path: string;
  filename: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf" | "audio/mp4" | "audio/webm";
  byte_size: number;
  status: "uploading" | "ready" | "failed";
  metadata: Record<string, unknown>;
  created_at: string;
  ready_at: string | null;
  url: string | null;
  forwarded?: boolean;
}

export interface ConversationAgent {
  id: string;
  slug: AgentSlug;
  display_name: string;
  role_label: string;
  avatar_url: string | null;
  voice_name: string | null;
  active: boolean;
}
export interface ConversationParticipant {
  id: string;
  type: "human" | "agent";
  display_name: string;
  avatar_url: string | null;
  agent_slug?: AgentSlug;
  role_label?: string;
  is_self?: boolean;
  is_admin?: boolean;
}

export interface ConversationMessageReaction {
  reaction: "👍" | "❤️" | "😂" | "😮" | "😢" | "🙏";
  count: number;
  self_reacted: boolean;
}

export interface ConversationMessage {
  id: string;
  client_message_id: string | null;
  conversation_id: string;
  author_profile_id: string | null;
  author_agent_id: string | null;
  kind: ConversationMessageKind;
  body: string;
  metadata: Record<string, unknown>;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  reactions: ConversationMessageReaction[];
  pinned_at: string | null;
  pinned_by: string | null;
  attachments: ConversationAttachment[];
  author: ConversationParticipant;
  search_match?: {
    kind: "message" | "attachment" | "both";
    attachment_filenames: string[];
  };
}

export interface ConversationAgentActivity {
  agent_id: string;
  status: "pending" | "processing";
  pending_turns: number;
  queued_at: string;
  claimed_at: string | null;
  progress_label: string | null;
  progress_updated_at: string | null;
}

export interface AgentTaskEvent {
  id: string;
  task_id: string;
  event_type: "created" | "queued" | "started" | "progress" | "artifact" | "approval_required" | "approved" | "rejected" | "changes_requested" | "completed" | "failed" | "cancelled";
  label: string;
  detail: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface AgentTaskArtifact {
  id: string;
  task_id: string;
  artifact_key: string;
  kind: "text" | "email_draft" | "report" | "file" | "record_change";
  title: string;
  content: Record<string, unknown>;
  status: "draft" | "approved" | "rejected" | "changes_requested" | "published";
  created_at: string;
  updated_at: string;
}

export interface AgentTask {
  id: string;
  conversation_id: string;
  project_id?: string | null;
  lead_id?: string | null;
  requested_by: string;
  owner_agent_id: string;
  delegated_by_agent_id?: string | null;
  source_task_id?: string | null;
  source_message_id: string | null;
  source_call_id: string | null;
  client_task_id: string;
  title: string;
  objective: string;
  requested_via: "text" | "voice" | "system";
  status: AgentTaskStatus;
  model_tier: AgentTaskModelTier;
  model_name: string | null;
  approval_state: "none" | "pending" | "approved" | "rejected" | "changes_requested";
  approval_note: string | null;
  result_summary: string | null;
  error: string | null;
  retry_count: number;
  gateway_run_id: string | null;
  progress_label: string | null;
  progress_updated_at: string | null;
  cancellation_requested_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  owner_agent?: ConversationParticipant;
  events: AgentTaskEvent[];
  artifacts: AgentTaskArtifact[];
}

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  title: string | null;
  display_title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  unread_count: number;
  notifications_muted: boolean;
  archived_at: string | null;
  pinned_at: string | null;
  participants: ConversationParticipant[];
  last_message: ConversationMessage | null;
  context: ConversationContext | null;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  people: ConversationParticipant[];
}
