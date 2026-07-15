export type LeadMeetingTranscriptStatus = "pending" | "processing" | "done" | "failed";

export interface LeadMeetingRecording {
  id: string;
  lead_id: string;
  storage_path: string;
  original_filename: string;
  mime_type: string | null;
  recorded_at: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  transcript_status: LeadMeetingTranscriptStatus;
  summary: string | null;
  action_items: string[];
  decisions: string[];
  failure_note: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface LeadMeetingRecordingWithUrl extends LeadMeetingRecording {
  audio_url: string | null;
  lead_name?: string | null;
}

export interface LeadMeetingListResponse {
  recordings: LeadMeetingRecordingWithUrl[];
}

export interface LeadMeetingUploadUrlResponse {
  path: string;
  token: string;
}

export interface CompleteLeadMeetingTranscriptionInput {
  status: "done" | "failed";
  transcript?: string;
  summary?: string;
  action_items?: string[];
  decisions?: string[];
  failure_note?: string;
}

