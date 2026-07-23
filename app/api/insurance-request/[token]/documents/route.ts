import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  allRequestedKindsUploaded,
  isInsuranceRequestAvailable,
  loadInsuranceRequestPortalData,
  normaliseInsuranceRequestKinds,
} from "@/lib/insurance-requests";
import { rateLimit } from "@/lib/rate-limit";
import { ASSET_BUCKET } from "@/lib/storage";

export const runtime = "nodejs";

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const limit = rateLimit(`insurance-document:${token}:${clientIp(request)}`, 15, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many upload attempts. Please wait a moment." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const kind = normaliseInsuranceRequestKinds(body?.kind ? [body.kind] : [])[0];
  const storagePath = typeof body?.storage_path === "string" ? body.storage_path : "";
  const filename =
    typeof body?.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "document";
  const expiryDate =
    typeof body?.expiry_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.expiry_date)
      ? body.expiry_date
      : null;
  if (!kind || !expiryDate) {
    return NextResponse.json(
      { error: "A valid document type and expiry date are required." },
      { status: 400 }
    );
  }

  const supabase = createServiceRoleClient();
  const documentRequest = await loadInsuranceRequestPortalData(supabase, token);
  if (!documentRequest) return NextResponse.json({ error: "Invalid link." }, { status: 404 });
  if (
    !isInsuranceRequestAvailable(documentRequest.status, documentRequest.expires_at) ||
    !documentRequest.requested_kinds.includes(kind)
  ) {
    return NextResponse.json(
      { error: "This request is no longer available for that document." },
      { status: 410 }
    );
  }

  const pathPrefix =
    `contacts/${documentRequest.contact_id}/documents/requests/${documentRequest.id}/`;
  if (!storagePath.startsWith(pathPrefix)) {
    return NextResponse.json({ error: "Invalid upload path." }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("contact_documents")
    .select("id")
    .eq("request_id", documentRequest.id)
    .eq("kind", kind)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();
  if (existing) {
    await supabase.storage.from(ASSET_BUCKET).remove([storagePath]);
    return NextResponse.json({
      ok: true,
      already_uploaded: true,
      status: documentRequest.status,
    });
  }

  const { data: document, error: insertError } = await supabase
    .from("contact_documents")
    .insert({
      contact_id: documentRequest.contact_id,
      request_id: documentRequest.id,
      kind,
      storage_path: storagePath,
      filename,
      expiry_date: expiryDate,
      uploaded_by: null,
    })
    .select()
    .single();
  if (insertError || !document) {
    await supabase.storage.from(ASSET_BUCKET).remove([storagePath]);
    return NextResponse.json(
      { error: insertError?.message ?? "Could not save the document." },
      { status: 500 }
    );
  }

  const uploadedKinds = normaliseInsuranceRequestKinds([
    ...documentRequest.uploaded_kinds,
    kind,
  ]);
  const completed = allRequestedKindsUploaded(
    documentRequest.requested_kinds,
    uploadedKinds
  );
  if (completed) {
    await supabase
      .from("contact_document_requests")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", documentRequest.id)
      .in("status", ["requested", "opened"]);
  }

  return NextResponse.json(
    {
      ok: true,
      document,
      uploaded_kinds: uploadedKinds,
      status: completed ? "completed" : "opened",
    },
    { status: 201 }
  );
}
