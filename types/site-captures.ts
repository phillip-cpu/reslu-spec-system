// ============================================================
// RESLU Spec System — Site capture + mobile QoL round (r21).
// Types for `site_captures` (migration 050_site_captures.sql) and its
// API routes. Kept in its own file per this codebase's house
// convention of one types/<feature>.ts file per round rather than
// editing the shared types/index.ts (protected/out of this round's
// edit boundary — see types/cpd.ts / types/client-invoices.ts for the
// same documented convention).
// ============================================================

export type SiteCaptureKind = "photo" | "note" | "audio";
export type SiteCaptureTranscriptStatus = "pending" | "done" | "failed";

/** Plain `site_captures` row, as stored. */
export interface SiteCapture {
  id: string;
  project_id: string;
  kind: SiteCaptureKind;
  storage_path: string | null;
  text_content: string | null;
  transcript: string | null;
  transcript_status: SiteCaptureTranscriptStatus | null;
  author_user_id: string | null;
  author_contact_id: string | null;
  trade_visit_id: string | null;
  created_at: string;
}

/** Lightweight author projection attached to each row for display — resolved server-side (profiles.full_name or contacts.company), never persisted on the row itself. */
export interface SiteCaptureAuthor {
  label: string;
  source: "user" | "contact";
}

/**
 * SiteCapture + a freshly-minted signed URL (private `site-captures`
 * bucket, short TTL — same discipline as ASSET_BUCKET) for photo/audio
 * rows. `thumb_url` is only ever set for kind='photo' (a grid-sized
 * rendition — see lib/image-url.ts's signedRenditionUrl) so the Site
 * diary can render a small thumbnail and only mint/download the
 * full-size `url` on click. Both are null on any signing failure
 * (matches every other createSignedUrl call site's error-swallowing
 * convention) and always null for kind='note'.
 */
export interface SiteCaptureWithUrl extends SiteCapture {
  url: string | null;
  thumb_url: string | null;
  author: SiteCaptureAuthor | null;
}

/** GET /api/projects/[id]/site-captures response — reverse-chronological. */
export interface SiteCaptureListResponse {
  captures: SiteCaptureWithUrl[];
}

/** POST /api/site-captures — JSON body shape for kind='note'. Photo/audio use multipart/form-data instead (fields: project_id, kind, file) — see that route's own doc comment. */
export interface CreateSiteCaptureNoteInput {
  project_id: string;
  kind: "note";
  text_content: string;
}

export interface SiteCaptureResponse {
  capture: SiteCaptureWithUrl;
}

/** MCP set_capture_transcript / PATCH /api/site-captures/[id]/transcript body. */
export interface SetCaptureTranscriptInput {
  transcript: string;
}

/** MCP list_pending_transcriptions / GET /api/site-captures/pending-transcriptions response entry — audio capture + signed URL + project, per BUILD-SPEC.md item 5. */
export interface PendingTranscriptionEntry {
  id: string;
  project_id: string;
  project_name: string | null;
  url: string | null;
  created_at: string;
}

export interface PendingTranscriptionsResponse {
  captures: PendingTranscriptionEntry[];
}
