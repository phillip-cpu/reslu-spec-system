import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import {
  SIGNATURE_CONSENT_STATEMENT,
  certificatePath,
  decodePngDataUrl,
  resolveDocumentBytes,
  sha256Hex,
  signatureImagePath,
  type SignRequestInput,
} from "@/lib/signatures";
import { SignatureCertificatePdf } from "@/components/portal/SignatureCertificatePdf";
import { sendTeamEmail, isGmailConfigured } from "@/lib/gmail/send";
import { reportError } from "@/lib/report-error";
import type { PortalSigningTarget } from "@/app/portal/types";

export const runtime = "nodejs";

/**
 * GET/POST /api/portal/[token]/sign/[requestId]
 *
 * BUILD-SPEC.md §"Built-in digital signature" — the security spec,
 * followed exactly:
 *
 *   "team marks a document/variation 'requires signature' → client
 *   opens it in the portal (token-gated) → full document displayed
 *   (must scroll/open before signing enabled) → client signs by
 *   drawing on canvas AND/OR typing full name (store both when given)
 *   → explicit consent checkbox ... → submit."
 *
 *   "Evidence record (signature_events table, append-only ...):
 *   document_sha256 (hash of the exact PDF/content signed — computed
 *   server-side at sign time), signer_name_typed, signature_image_path
 *   (drawn PNG in private storage), portal_token_used, ip, user_agent,
 *   signed_at. Then: generate a signature-certificate page ... store
 *   the stamped PDF as a new immutable file (never overwrite the
 *   original); email copies to client + admins; ... Any change to a
 *   signed subject ... voids the badge and requires re-signing (hash
 *   mismatch makes this automatic)."
 *
 * "Opened before signing enabled" is enforced client-side (the sign
 * page disables the submit button until the iframe/document has been
 * interacted with) AND is not re-verified server-side beyond ownership
 * — this mirrors the portal's general trust model (the token is the
 * real boundary; UI gating is a UX nudge, not a security control this
 * route can observe). The consent checkbox and document ownership ARE
 * server-verified below, since those are things a client could
 * otherwise skip by calling the API directly.
 */

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

async function resolveSubjectFilename(
  supabase: ReturnType<typeof createServiceRoleClient>,
  subjectType: string,
  subjectId: string
): Promise<string> {
  if (subjectType === "project_file") {
    const { data } = await supabase
      .from("project_files")
      .select("filename")
      .eq("id", subjectId)
      .single();
    return data?.filename ?? "Document";
  }
  if (subjectType === "variation") {
    const { data } = await supabase
      .from("variations")
      .select("var_number")
      .eq("id", subjectId)
      .single();
    return data ? `Variation ${data.var_number}` : "Variation";
  }
  return "Scope of Works";
}

/** GET — fetch the signing target: document to render + current status. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; requestId: string }> }
) {
  const { token, requestId } = await params;

  const limit = rateLimit(`portal-sign-get:${token}:${clientIp(request)}`);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("client_token", token)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  const { data: signatureRequest } = await supabase
    .from("signature_requests")
    .select("id,project_id,subject_type,subject_id,status")
    .eq("id", requestId)
    .eq("project_id", project.id) // ownership: request MUST belong to this token's project
    .single();

  if (!signatureRequest) {
    return NextResponse.json({ error: "Signature request not found" }, { status: 404 });
  }

  const filename = await resolveSubjectFilename(
    supabase,
    signatureRequest.subject_type,
    signatureRequest.subject_id
  );

  let documentUrl: string | null = null;
  if (signatureRequest.subject_type === "project_file") {
    const { data: file } = await supabase
      .from("project_files")
      .select("storage_path")
      .eq("id", signatureRequest.subject_id)
      .single();
    if (file) {
      const { data: signed } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);
      documentUrl = signed?.signedUrl ?? null;
    }
  }

  const target: PortalSigningTarget = {
    request_id: signatureRequest.id,
    project_id: signatureRequest.project_id,
    subject_type: signatureRequest.subject_type,
    subject_id: signatureRequest.subject_id,
    status: signatureRequest.status,
    document_filename: filename,
    document_url: documentUrl,
  };

  return NextResponse.json({ target, consentStatement: SIGNATURE_CONSENT_STATEMENT });
}

/** POST — submit the signature: hash, store, record evidence, generate certificate, email. */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; requestId: string }> }
) {
  const { token, requestId } = await params;

  const limit = rateLimit(`portal-sign-post:${token}:${clientIp(request)}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: SignRequestInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.consent !== true) {
    return NextResponse.json(
      { error: "You must accept the consent statement to sign." },
      { status: 400 }
    );
  }
  const signerNameTyped = body.signer_name_typed?.trim();
  if (!signerNameTyped) {
    return NextResponse.json({ error: "Full name is required." }, { status: 400 });
  }
  const signatureBytes = decodePngDataUrl(body.signature_data_url ?? "");
  if (!signatureBytes || signatureBytes.byteLength === 0) {
    return NextResponse.json({ error: "A drawn signature is required." }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name")
    .eq("client_token", token)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  const { data: signatureRequest } = await supabase
    .from("signature_requests")
    .select("id,project_id,subject_type,subject_id,status")
    .eq("id", requestId)
    .eq("project_id", project.id) // ownership boundary, same as every other portal route
    .single();

  if (!signatureRequest) {
    return NextResponse.json({ error: "Signature request not found" }, { status: 404 });
  }
  if (signatureRequest.status !== "pending") {
    return NextResponse.json(
      { error: `This request is already ${signatureRequest.status} and cannot be signed again.` },
      { status: 409 }
    );
  }

  // Server-side hash of the EXACT bytes/content signed — never trust a
  // client-supplied hash (BUILD-SPEC.md: "computed server-side at sign time").
  const resolved = await resolveDocumentBytes(
    supabase,
    signatureRequest.subject_type,
    signatureRequest.subject_id
  );
  if (!resolved) {
    return NextResponse.json(
      { error: "The document for this request could not be found." },
      { status: 404 }
    );
  }
  const documentSha256 = sha256Hex(resolved.bytes);

  // Store the drawn signature PNG in PRIVATE storage.
  const sigPath = signatureImagePath(project.id, signatureRequest.id);
  const { error: sigUploadError } = await supabase.storage
    .from(ASSET_BUCKET)
    .upload(sigPath, signatureBytes, { contentType: "image/png", upsert: false });
  if (sigUploadError) {
    return NextResponse.json(
      { error: `Could not store signature: ${sigUploadError.message}` },
      { status: 500 }
    );
  }

  const ip = clientIp(request);
  const userAgent = request.headers.get("user-agent");
  const signedAt = new Date();

  // Append-only evidence insert. Uses the service-role client — the
  // migration's RLS design point ("INSERT via service role for
  // portal") — this route is unauthenticated by session, exactly like
  // every other portal route in this codebase.
  const { error: eventError } = await supabase.from("signature_events").insert({
    project_id: project.id,
    subject_type: signatureRequest.subject_type,
    subject_id: signatureRequest.subject_id,
    signature_request_id: signatureRequest.id,
    document_sha256: documentSha256,
    signer_name_typed: signerNameTyped,
    signature_image_path: sigPath,
    portal_token_used: token,
    ip,
    user_agent: userAgent,
    signed_at: signedAt.toISOString(),
  });
  if (eventError) {
    // Best-effort cleanup of the orphaned signature image.
    await supabase.storage.from(ASSET_BUCKET).remove([sigPath]);
    // Phase 14A error visibility — a failure to record signature
    // evidence is about as high-value as this route gets to know
    // about (see lib/report-error.ts, admin Settings "System health").
    await reportError("signature-route", eventError);
    return NextResponse.json(
      { error: `Could not record signature evidence: ${eventError.message}` },
      { status: 500 }
    );
  }

  const { error: statusError } = await supabase
    .from("signature_requests")
    .update({ status: "signed" })
    .eq("id", signatureRequest.id)
    .eq("project_id", project.id); // defence in depth
  if (statusError) {
    return NextResponse.json(
      { error: "Signature recorded but the request status could not be updated." },
      { status: 500 }
    );
  }

  // Generate the signature certificate (separate branded PDF — no
  // pdf-lib/stamping library is available in this working copy; see
  // components/portal/SignatureCertificatePdf.tsx for the rationale).
  // Never fails the sign response if generation/storage/email hiccups —
  // the evidence row above is already durable and is the real record.
  let certificateUrl: string | null = null;
  try {
    const filename = await resolveSubjectFilename(
      supabase,
      signatureRequest.subject_type,
      signatureRequest.subject_id
    );
    const signedAtAest = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Brisbane", // AEST, no daylight saving — matches SA/QLD wall-clock offset used elsewhere in this app
      dateStyle: "long",
      timeStyle: "short",
    }).format(signedAt);

    const certificateBuffer = await renderToBuffer(
      SignatureCertificatePdf({
        projectName: project.name,
        clientName: project.client_name,
        documentFilename: filename,
        documentSha256,
        signerNameTyped,
        signedAtAest: `${signedAtAest} AEST`,
        signatureImageDataUrl: body.signature_data_url,
        subjectType: signatureRequest.subject_type,
        ipAddress: ip,
      })
    );

    const certPath = certificatePath(project.id, signatureRequest.id);
    const { error: certUploadError } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(certPath, certificateBuffer, {
        contentType: "application/pdf",
        upsert: false,
      });

    if (!certUploadError) {
      // Certificate is stored as a NEW file next to the original — for
      // project_file subjects, indexed as its own project_files row
      // (kind: 'other') so it shows up in the team's Documents list
      // and the portal Documents section, never overwriting the
      // original signed file's row.
      if (signatureRequest.subject_type === "project_file") {
        await supabase.from("project_files").insert({
          project_id: project.id,
          kind: "other",
          storage_path: certPath,
          filename: `${filename} — signature certificate.pdf`,
          revision_label: null,
          uploaded_by: null,
        });
      }
      const { data: signedCert } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(certPath, SIGNED_URL_TTL_SECONDS);
      certificateUrl = signedCert?.signedUrl ?? null;
    }

    // Email copies to client + admins (BUILD-SPEC.md). No-op cleanly if
    // Gmail isn't configured — sendTeamEmail/isGmailConfigured already
    // handle that; this never throws into the response.
    if (isGmailConfigured()) {
      const { data: admins } = await supabase
        .from("profiles")
        .select("email")
        .eq("role", "admin");
      const recipients = [
        ...(admins ?? []).map((a: { email: string }) => a.email),
      ].filter(Boolean);
      // No client email column exists on `projects` today (client_name
      // is a display string, not a contact) — recipients are admins
      // only until a client-contact-email field exists. Documented
      // here rather than silently only-partially satisfying the spec.
      if (recipients.length > 0) {
        await sendTeamEmail({
          to: recipients,
          subject: `${project.name} — ${filename} signed by ${signerNameTyped}`,
          body: `${filename} was signed by ${signerNameTyped} on ${signedAtAest} AEST.\n\nDocument SHA-256: ${documentSha256}\n${certificateUrl ? `Certificate: ${certificateUrl}` : ""}`,
        }).catch(() => {});
      }
    }
  } catch (err) {
    // Certificate/email failures never fail the sign response — the
    // signature_events row is already the durable evidence record.
    // Phase 14A error visibility — this used to be a silent swallow;
    // now it's recorded so a repeatedly-failing certificate/email step
    // is visible in admin Settings "System health" instead of only
    // discoverable by a client asking "where's my copy?" (see
    // lib/report-error.ts).
    await reportError("signature-route", err);
  }

  return NextResponse.json({
    status: "signed",
    signed_at: signedAt.toISOString(),
    certificate_url: certificateUrl,
  });
}
