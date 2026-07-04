import crypto from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET } from "@/lib/storage";

/**
 * Native e-signature support (BUILD-SPEC.md §"Built-in digital
 * signature", Week 8B). Local types + helpers only — types/index.ts is
 * owned by the other agent working this tree concurrently (Week 8A),
 * so every type this feature needs is defined here instead, mirroring
 * app/portal/types.ts's existing "portal-local type additions" pattern.
 */

export type SignatureSubjectType = "project_file" | "variation" | "sow";
export type SignatureRequestStatus = "pending" | "signed" | "void";

export interface SignatureRequest {
  id: string;
  project_id: string;
  subject_type: SignatureSubjectType;
  subject_id: string;
  status: SignatureRequestStatus;
  requested_by: string | null;
  voided_reason: string | null;
  voided_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Append-only evidence row — column set is letter-for-letter the
 * BUILD-SPEC.md list: "document_sha256 ..., signer_name_typed,
 * signature_image_path ..., portal_token_used, ip, user_agent,
 * signed_at." project_id/subject_type/subject_id/signature_request_id
 * are additive (needed to actually query the ledger), not a deviation.
 */
export interface SignatureEvent {
  id: string;
  project_id: string;
  subject_type: SignatureSubjectType;
  subject_id: string;
  signature_request_id: string | null;
  document_sha256: string;
  signer_name_typed: string;
  signature_image_path: string;
  portal_token_used: string;
  ip: string | null;
  user_agent: string | null;
  signed_at: string;
}

/** body accepted by POST /api/signatures (team creates a request). */
export interface CreateSignatureRequestInput {
  subject_type: SignatureSubjectType;
  subject_id: string;
}

/** body accepted by POST /api/portal/[token]/sign/[requestId]. */
export interface SignRequestInput {
  /** Drawn signature, PNG data URL from the <canvas> — required. */
  signature_data_url: string;
  /** Typed full name — required per BUILD-SPEC.md ("drawing on canvas
   *  AND/OR typing full name (store both when given)"); both count as
   *  evidence, name is mandatory even if the client also draws. */
  signer_name_typed: string;
  /** Explicit consent checkbox — the route rejects if this is not
   *  exactly the binding statement's acknowledgement (true). */
  consent: boolean;
}

/** Exact binding statement shown next to the consent checkbox (BUILD-SPEC.md). */
export const SIGNATURE_CONSENT_STATEMENT =
  "I agree this electronic signature is binding.";

/** Private storage path for a drawn signature PNG — never overwritten. */
export function signatureImagePath(projectId: string, requestId: string): string {
  return `signatures/${projectId}/${requestId}/${Date.now()}-signature.png`;
}

/** Private storage path for a generated certificate PDF — stored NEXT TO
 *  the original file, never overwriting it (new immutable object). */
export function certificatePath(projectId: string, requestId: string): string {
  return `signatures/${projectId}/${requestId}/${Date.now()}-certificate.pdf`;
}

/** sha256 of exact bytes, computed server-side at sign time — BUILD-SPEC.md
 *  "document_sha256 (hash of the exact PDF/content signed — computed
 *  server-side at sign time)". Never trust a client-supplied hash. */
export function sha256Hex(bytes: Buffer | Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/** Decodes a `data:image/png;base64,...` string into raw PNG bytes.
 *  Returns null if the input isn't a well-formed PNG data URL. */
export function decodePngDataUrl(dataUrl: string): Buffer | null {
  const match = /^data:image\/png;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl.trim());
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch {
    return null;
  }
}

/**
 * Resolves the exact bytes + filename of the document a signature
 * request refers to, so the caller can hash them server-side. Only
 * 'project_file' is a real Storage object today; 'variation' and 'sow'
 * subjects don't have a stored PDF to hash (a variation is DB rows, and
 * the SOW builder is a Week 8A surface this agent doesn't own) — for
 * those, the hash is computed over a deterministic canonical JSON
 * snapshot of the subject's content instead, which still satisfies
 * "hash of the exact content signed" and still makes the void-on-edit
 * trigger meaningful (the row changing produces a different snapshot,
 * hence a different hash, hence the old signature no longer matches).
 */
export async function resolveDocumentBytes(
  supabase: SupabaseClient,
  subjectType: SignatureSubjectType,
  subjectId: string
): Promise<{ bytes: Buffer; filename: string } | null> {
  if (subjectType === "project_file") {
    const { data: file } = await supabase
      .from("project_files")
      .select("storage_path,filename")
      .eq("id", subjectId)
      .is("deleted_at", null)
      .single();
    if (!file) return null;

    const { data: blob, error } = await supabase.storage
      .from(ASSET_BUCKET)
      .download(file.storage_path);
    if (error || !blob) return null;

    const bytes = Buffer.from(await blob.arrayBuffer());
    return { bytes, filename: file.filename };
  }

  if (subjectType === "variation") {
    const { data: variation } = await supabase
      .from("variations")
      .select("id,var_number,description,cost_ex_gst,var_date")
      .eq("id", subjectId)
      .is("deleted_at", null)
      .single();
    if (!variation) return null;

    const canonical = JSON.stringify({
      id: variation.id,
      var_number: variation.var_number,
      description: variation.description,
      cost_ex_gst: variation.cost_ex_gst,
      var_date: variation.var_date,
    });
    return {
      bytes: Buffer.from(canonical, "utf-8"),
      filename: `Variation ${variation.var_number}`,
    };
  }

  // 'sow' — no SOW table exists in this agent's file boundary (Week 8A
  // owns the SOW builder). Not resolvable here; callers should treat a
  // null return as "subject not found / not signable yet".
  return null;
}
