import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  isInsuranceRequestAvailable,
  loadInsuranceRequestPortalData,
  normaliseInsuranceRequestKinds,
} from "@/lib/insurance-requests";
import { rateLimit } from "@/lib/rate-limit";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";

export const runtime = "nodejs";

function clientIp(request: NextRequest): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const limit = rateLimit(`insurance-upload-url:${token}:${clientIp(request)}`, 15, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many upload attempts. Please wait a moment." },
      { status: 429 }
    );
  }

  const body = await request.json().catch(() => null);
  const kinds = normaliseInsuranceRequestKinds(body?.kind ? [body.kind] : []);
  const kind = kinds[0];
  const filename =
    typeof body?.filename === "string" && body.filename.trim()
      ? body.filename.trim()
      : "document";
  if (!kind) return NextResponse.json({ error: "Invalid document type." }, { status: 400 });

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
  if (documentRequest.uploaded_kinds.includes(kind)) {
    return NextResponse.json(
      { error: "This document has already been uploaded." },
      { status: 409 }
    );
  }

  const path =
    `contacts/${documentRequest.contact_id}/documents/requests/${documentRequest.id}/` +
    `${Date.now()}-${slugFilename(filename)}`;
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUploadUrl(path);
  if (error) {
    return NextResponse.json({ error: "Could not prepare the upload." }, { status: 500 });
  }

  return NextResponse.json({ path: data.path, token: data.token });
}
