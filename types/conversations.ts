export type ConversationKind = "direct" | "group";
export type ConversationMessageKind = "text" | "call_record" | "meeting_record" | "system";
export type AgentSlug = "aria" | "marco";

export interface ConversationAttachment {
  id: string;
  conversation_id: string;
  message_id: string | null;
  uploaded_by: string;
  storage_path: string;
  filename: string;
  mime_type: "image/jpeg" | "image/png" | "image/webp" | "application/pdf";
  byte_size: number;
  status: "uploading" | "ready" | "failed";
  metadata: Record<string, unknown>;
  created_at: string;
  ready_at: string | null;
  url: string | null;
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
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  author_profile_id: string | null;
  author_agent_id: string | null;
  kind: ConversationMessageKind;
  body: string;
  metadata: Record<string, unknown>;
  reply_to_id: string | null;
  created_at: string;
  edited_at: string | null;
  attachments: ConversationAttachment[];
  author: ConversationParticipant;
}

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  title: string | null;
  display_title: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  participants: ConversationParticipant[];
  last_message: ConversationMessage | null;
}

export interface ConversationsResponse {
  conversations: ConversationSummary[];
  people: ConversationParticipant[];
}
