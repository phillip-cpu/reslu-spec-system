export const DEFAULT_MEETING_RECORDING_RETENTION_DAYS = 30;
export const DEFAULT_MEETING_TRANSCRIPT_RETENTION_DAYS = 365;
export const MEETING_RETENTION_ENABLE_CONFIRMATION = "ENABLE AUTOMATIC DELETION";

export interface MeetingSourceRetentionPolicy {
  singleton: boolean;
  recording_days: number;
  transcript_days: number;
  enabled: boolean;
  approved_at: string | null;
  approved_by: string | null;
  updated_at: string;
  updated_by: string | null;
}

export interface MeetingSourceRetentionDueCounts {
  recordings: number;
  transcripts: number;
}

export type MeetingSourceRetentionAction = "save" | "enable" | "disable";

export interface MeetingSourceRetentionUpdate {
  recordingDays: number;
  transcriptDays: number;
  action: MeetingSourceRetentionAction;
}

export function cleanMeetingSourceRetentionUpdate(value: unknown): MeetingSourceRetentionUpdate | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const recordingDays = Number(source.recording_days);
  const transcriptDays = Number(source.transcript_days);
  const action = source.action;
  if (!Number.isInteger(recordingDays) || recordingDays < 1 || recordingDays > 365) return null;
  if (!Number.isInteger(transcriptDays) || transcriptDays < 1 || transcriptDays > 3650) return null;
  if (transcriptDays < recordingDays) return null;
  if (action !== "save" && action !== "enable" && action !== "disable") return null;
  if (action === "enable" && source.confirmation !== MEETING_RETENTION_ENABLE_CONFIRMATION) return null;
  return { recordingDays, transcriptDays, action };
}
