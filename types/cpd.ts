// ============================================================
// RESLU Spec System — CPD point tracker.
// Types for `cpd_entries` (migration 047_cpd.sql) and its API routes.
// Kept in its own file per this codebase's house convention of one
// types/<feature>.ts file per round rather than editing the shared
// types/index.ts (out of this round's edit boundary — see
// types/client-invoices.ts / types/sow-trade-tags.ts for the same
// convention, documented there).
// ============================================================

/** app_settings key 'cpd_defaults' value shape — see lib/cpd.ts FALLBACK_CPD_DEFAULTS. */
export interface CpdDefaults {
  annual_target: number;
  /** 1-12, 7 = July. */
  year_start_month: number;
}

/** GET /api/settings/cpd-defaults response. */
export interface CpdDefaultsResponse {
  defaults: CpdDefaults;
}

/** Inclusive [start, end] date-only window — see lib/cpd.ts computeCpdYearWindow(). */
export interface CpdYearWindow {
  start: string;
  end: string;
}

/** Minimal shape lib/cpd.ts's cpdEntriesToCsv() needs — a structural subset of CpdEntry so the pure lib file doesn't need to import the full interface (kept here anyway for import-site convenience). */
export interface CpdEntryLike {
  activity_date: string;
  activity_title: string;
  provider: string | null;
  category: string | null;
  points: number;
  notes: string | null;
  evidence_path: string | null;
}

/** Lightweight profile projection attached to each entry — always present so the admin "All team" view can group by person without a second round-trip; ignored by the own-entries view. */
export interface CpdEntryProfile {
  id: string;
  full_name: string;
}

export interface CpdEntry extends CpdEntryLike {
  id: string;
  user_id: string;
  evidence_filename: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  /** Freshly-minted signed URL (assets bucket, short TTL) when evidence_path is set — null if unset or the sign call failed. Never persisted; re-minted on every GET, same pattern as GET /api/contacts/[id]/documents's withUrl(). */
  evidence_url: string | null;
  profile: CpdEntryProfile | null;
}

/** GET /api/cpd response. `all` reflects whether ?all=1 was honoured (false for a non-admin even if they passed it — see the route's own doc comment). */
export interface CpdListResponse {
  entries: CpdEntry[];
  defaults: CpdDefaults;
  window: CpdYearWindow;
  current_user: CpdEntryProfile;
  is_admin: boolean;
  all: boolean;
}

/** POST /api/cpd body. user_id is ADMIN-ONLY (see the route's doc comment) — a non-admin caller always gets their own user_id regardless of what's passed, which is why this field is optional and silently ignored rather than erroring for a non-admin. evidence_path/evidence_filename come from the two-step signed-upload flow (POST /api/cpd/evidence/upload-url), same as ContactDocumentsPanel's pattern. */
export interface CreateCpdEntryInput {
  activity_title: string;
  provider?: string | null;
  activity_date: string;
  points: number;
  category?: string | null;
  notes?: string | null;
  evidence_path?: string | null;
  evidence_filename?: string | null;
  /** Admin-only — attributes the entry to a different user (e.g. the add_cpd_entry MCP tool, resolving a team member's email to their profile id). Ignored (forced to the caller's own id) for a non-admin. */
  user_id?: string;
}

/** PATCH /api/cpd/[id] body — all fields optional, partial update. Passing evidence_path: null clears any existing evidence (and removes the underlying Storage object — see the route's doc comment). */
export interface PatchCpdEntryInput {
  activity_title?: string;
  provider?: string | null;
  activity_date?: string;
  points?: number;
  category?: string | null;
  notes?: string | null;
  evidence_path?: string | null;
  evidence_filename?: string | null;
}

export interface CpdEntryResponse {
  entry: CpdEntry;
}

/** POST /api/cpd/evidence/upload-url response — same shape as every other signed-upload mint in this codebase (POST /api/contacts/[id]/documents/upload-url). */
export interface CpdEvidenceUploadUrlResponse {
  path: string;
  token: string;
}
