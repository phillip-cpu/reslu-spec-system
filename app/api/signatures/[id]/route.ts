import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";

/**
 * GET /api/signatures/[id] — single signature request with its
 * evidence + a signed URL to its certificate (if one was generated),
 * for the team client-area "view certificate" link.
 *
 * PATCH /api/signatures/[id] — team manually voids a request (e.g. a
 * superseded document that isn't covered by the automatic
 * void-on-variation-edit trigger — see migration 012's PART 6 comment
 * on why project_files revisions need a manual void instead of a
 * trigger). Body: { action: "void", reason?: string }. Team-authenticated,
 * not admin-only (matches the contract flow's general access level).
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: signatureRequest, error } = await supabase
    .from("signature_requests")
    .select("*")
    .eq("id", id)
    .single();
  if (error || !signatureRequest) {
    return NextResponse.json({ error: "Signature request not found" }, { status: 404 });
  }

  const { data: event } = await supabase
    .from("signature_events")
    .select("*")
    .eq("signature_request_id", id)
    .order("signed_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  let certificateUrl: string | null = null;
  if (event) {
    // The certificate is indexed as a project_files row (kind: 'other')
    // for project_file subjects — see the sign route's insert. Look it
    // up by filename convention isn't reliable, so instead re-derive
    // via the same path scheme (certificatePath is deterministic per
    // project+request, timestamped, so list+match the prefix).
    const { data: files } = await supabase.storage
      .from(ASSET_BUCKET)
      .list(`signatures/${signatureRequest.project_id}/${id}`);
    const certObject = (files ?? []).find((f) => f.name.endsWith("-certificate.pdf"));
    if (certObject) {
      const { data: signed } = await supabase.storage
        .from(ASSET_BUCKET)
        .createSignedUrl(
          `signatures/${signatureRequest.project_id}/${id}/${certObject.name}`,
          SIGNED_URL_TTL_SECONDS
        );
      certificateUrl = signed?.signedUrl ?? null;
    }
  }

  return NextResponse.json({
    request: signatureRequest,
    evidence: event ?? null,
    certificate_url: certificateUrl,
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { action?: string; reason?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.action !== "void") {
    return NextResponse.json({ error: "Only action: 'void' is supported" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("signature_requests")
    .update({
      status: "void",
      voided_reason: body.reason?.trim() || "Voided by team — document superseded.",
      voided_at: new Date().toISOString(),
    })
    .eq("id", id)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ request: updated });
}
