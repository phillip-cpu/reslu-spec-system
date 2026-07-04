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
  kind: "spec_sheet" | "install_manual" | "other";
  filename: string;
  /** Time-limited signed Supabase Storage URL — never a public/permanent one. */
  url: string;
}

/** PortalItem extended with its downloadable documents. */
export interface PortalItemWithFiles extends PortalItem {
  files: PortalItemFile[];
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
  kind: "plans" | "council" | "engineering" | "scope_of_works" | "other";
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
