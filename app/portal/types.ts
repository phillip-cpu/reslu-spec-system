import type { PortalItem } from "@/types";

/**
 * Portal-local type additions.
 *
 * types/index.ts is owned by the scraper/library agent working in this
 * same tree concurrently (see task file-boundary rules) — new types
 * needed only by the portal/PDF surfaces are defined here instead of
 * editing that shared file.
 */

/** A downloadable document surfaced on the portal, with a signed URL. */
export interface PortalItemFile {
  id: string;
  kind: "spec_sheet" | "install_manual" | "other" | "warranty";
  filename: string;
  /** Time-limited signed Supabase Storage URL — never a public/permanent one. */
  url: string;
}

/** PortalItem extended with its downloadable documents. */
export interface PortalItemWithFiles extends PortalItem {
  files: PortalItemFile[];
  /** Phase 11B — design-phase decision deadline (BUILD-SPEC.md §"Phase
   * 11 additions — confirmed by Phillip" point 2). Null = no deadline set. */
  decision_needed_by: string | null;
}

// ------------------------------------------------------------
// Week 8B — portal expansion + native e-signature.
// BUILD-SPEC.md §"Week 8 — Client portal expansion" /
// §"Built-in digital signature". Local types only — see
// lib/signatures.ts for the signature request/event shapes shared
// with the team-side client area (that file is the single source of
// truth for those; re-exported here for portal-component convenience).
// ------------------------------------------------------------

export type {
  SignatureSubjectType,
  SignatureRequestStatus,
  SignatureRequest,
} from "@/lib/signatures";

import type { SignatureRequestStatus, SignatureSubjectType } from "@/lib/signatures";

/** A project_files row shared to the portal (share_to_portal = true), with a signed URL. */
export interface PortalDocument {
  id: string;
  kind: "plans" | "council" | "engineering" | "scope_of_works" | "other" | "certificate";
  filename: string;
  revision_label: string | null;
  uploaded_at: string;
  url: string;
  /** Present when this file has an associated signature request. */
  signature?: PortalSignatureSummary | null;
}

/** Minimal signature-request info surfaced on the portal (no internal ids beyond what's needed to sign). */
export interface PortalSignatureSummary {
  request_id: string;
  status: SignatureRequestStatus;
  subject_type: SignatureSubjectType;
  signed_by: string | null;
  signed_at: string | null;
}

/** A variation shared to the portal — cost INC GST only (BUILD-SPEC.md's deliberate pricing exception). */
export interface PortalVariation {
  id: string;
  var_number: number;
  var_date: string;
  description: string;
  /** Client-facing cost, GST-inclusive — the one place item/variation pricing is shown on the portal. */
  cost_inc_gst: number;
  client_response: "approved" | "declined" | null;
  client_response_note: string | null;
  client_responded_at: string | null;
  signature?: PortalSignatureSummary | null;
}

/** body sent to POST /api/portal/[token]/variation/[id]/respond */
export interface RespondVariationInput {
  response: "approved" | "declined";
  note?: string;
}

/** A progress photo with a signed URL. */
export interface PortalProgressPhoto {
  id: string;
  url: string;
  caption: string | null;
  taken_at: string | null;
  created_at: string;
}

/** A published portal update, feed-ready. */
export interface PortalUpdate {
  id: string;
  title: string;
  body_richtext: string;
  published_at: string;
  /** Phase 11B — magazine-style diary entry images (1-2), signed URLs, from portal_update_photos. */
  photos: { id: string; url: string; caption: string | null }[];
}

/** The pending signature request being signed, with everything the sign page needs. */
export interface PortalSigningTarget {
  request_id: string;
  project_id: string;
  subject_type: SignatureSubjectType;
  subject_id: string;
  status: SignatureRequestStatus;
  document_filename: string;
  /** Signed URL to view the document (PDF) in an iframe — null for variation/sow subjects with no stored file. */
  document_url: string | null;
}

// ------------------------------------------------------------
// Phase 11B — portal v2 additions.
// BUILD-SPEC.md §"Phase 11 — Client portal v2 + trade confirmations"
// points 2-5, §"Phase 11 additions — confirmed by Phillip".
// ------------------------------------------------------------

/** "What's next" block — derived-only, no pricing/contact details, trade company names only. */
export interface PortalWhatsNext {
  this_week: { phase_names: string[]; trade_companies: string[] };
  next_week: { phase_names: string[]; trade_companies: string[] };
}

/** A handover-pack file (project_files or item_files, curated in_handover_pack = true). */
export interface PortalHandoverFile {
  id: string;
  kind: string;
  filename: string;
  url: string;
  /** Present for item_files — which item this manual/warranty belongs to. */
  item_name?: string;
}

/** The Handover section's full payload — only rendered when project status = 'completed'. */
export interface PortalHandoverPack {
  manuals_and_warranties: PortalHandoverFile[];
  certificates: PortalHandoverFile[];
  documents: PortalHandoverFile[];
  gallery: { id: string; url: string; caption: string | null }[];
}

// ------------------------------------------------------------
// Phase 12a-B — client_events (BUILD-SPEC.md §"Portal — upcoming
// client meetings"). Local portal type — the team-side CRUD types
// (ClientEvent, CreateClientEventInput, etc.) live in
// types/phase-12a-b.ts (this feature's own isolated types file, kept
// separate from types/index.ts for the same concurrent-agent reason
// documented there); this portal-only projection is defined here
// instead, alongside every other portal-local type, per this file's
// own established convention.
// ------------------------------------------------------------

/** A client_events row as shown on the portal's "Upcoming meetings" card — future events only (past ones are dropped by the page query before this shape is even built), no internal-only fields. `notes` IS client-facing on this table (unlike trade_visits.notes) — see lib/client-event-reminders.ts's doc comment for the same point. */
export interface PortalClientEvent {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
}
