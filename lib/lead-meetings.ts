import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS, slugFilename } from "@/lib/storage";
import type { LeadMeetingRecording, LeadMeetingRecordingWithUrl } from "@/types/lead-meetings";
export { cleanStringList, validLeadMeetingStoragePath } from "@/lib/lead-meeting-utils";

export function leadMeetingStoragePath(leadId: string, userId: string, filename: string): string {
  return `lead-meetings/${leadId}/${userId}/${Date.now()}-${slugFilename(filename || "meeting-audio")}`;
}

export async function withLeadMeetingUrl(
  supabase: SupabaseClient,
  row: LeadMeetingRecording
): Promise<LeadMeetingRecordingWithUrl> {
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
  return { ...row, audio_url: error ? null : data?.signedUrl ?? null };
}
