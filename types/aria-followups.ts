export type AriaFollowupStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "sent"
  | "failed";

export interface AriaFollowupDraft {
  id: string;
  lead_id: string;
  source_queue_id: string | null;
  dedupe_key: string;
  recipient_email: string;
  subject: string;
  body: string;
  context_summary: string | null;
  status: AriaFollowupStatus;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  decision_note: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
  lead?: {
    id: string;
    first_name: string | null;
    surname_project: string;
    stage: string;
    follow_up_date: string | null;
  } | null;
}

export interface SubmitAriaFollowupDraftInput {
  lead_id: string;
  source_queue_id?: string | null;
  dedupe_key: string;
  recipient_email: string;
  subject: string;
  body: string;
  context_summary?: string | null;
}
