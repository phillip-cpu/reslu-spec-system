export type MeetingMinutesStatus = "recording" | "paused" | "processing" | "review" | "filed" | "discarded" | "failed";
export type MeetingDestinationKind = "lead" | "project";
export type MeetingType = "new_lead" | "design_meeting" | "client_meeting" | "site_meeting" | "other";

export interface MeetingTranscriptSegment {
  item_id: string;
  text: string;
  sequence: number;
  captured_at: string;
}

export interface MeetingDestinationCandidate {
  kind: MeetingDestinationKind;
  id: string;
  label: string;
  subtitle: string | null;
  client_event_id: string | null;
  source_reference: string | null;
  duplicate_filed_minutes_id: string | null;
  confidence: number;
  reasons: string[];
  meeting_type: MeetingType;
}

export interface ConversationMeetingMinutes {
  id: string;
  conversation_id: string;
  source_call_id: string | null;
  created_by: string;
  client_session_id: string;
  status: MeetingMinutesStatus;
  meeting_type: MeetingType;
  lead_id: string | null;
  project_id: string | null;
  client_event_id: string | null;
  destination_kind: MeetingDestinationKind | null;
  destination_label_snapshot: string | null;
  destination_confidence: number | null;
  destination_reasons: string[];
  source_snapshot: Record<string, unknown>;
  consent_confirmed_at: string;
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  recording_storage_path: string | null;
  recording_filename: string | null;
  recording_mime_type: string | null;
  recording_byte_size: number | null;
  recording_retain_until: string | null;
  recording_deleted_at: string | null;
  recording_deleted_by: string | null;
  transcript: string | null;
  transcript_segments: MeetingTranscriptSegment[];
  transcript_retain_until: string | null;
  transcript_deleted_at: string | null;
  transcript_deleted_by: string | null;
  summary: string | null;
  decisions: string[];
  client_requests: string[];
  reslu_actions: string[];
  client_actions: string[];
  open_questions: string[];
  important_notes: string[];
  draft_version: number;
  filed_message_id: string | null;
  filed_by: string | null;
  filed_at: string | null;
  failure_note: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface MeetingContextResponse {
  current_user_id: string;
  candidates: MeetingDestinationCandidate[];
  suggested: MeetingDestinationCandidate | null;
  needs_clarification: boolean;
  clarification: string | null;
  active_minutes: ConversationMeetingMinutes | null;
}
