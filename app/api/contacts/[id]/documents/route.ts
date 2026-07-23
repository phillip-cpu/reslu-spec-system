import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type { ContactDocument, ContactDocumentKind, CreateContactDocumentInput } from "@/lib/insurance";
import type { InsuranceRequestSummary } from "@/types/insurance-requests";

export const runtime = "nodejs";

const KINDS: ContactDocumentKind[] = [
  "public_liability",
  "professional_indemnity",
  "workers_comp",
  "licence",
  "other",
];

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * `assets` is a PRIVATE bucket (migration 009) — mint a short-TTL
 * signed URL per request rather than getPublicUrl(). Mirrors
 * app/api/projects/[id]/files/route.ts's withUrl() exactly.
 */
async function withUrl(supabase: SupabaseServerClient, doc: ContactDocument) {
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(doc.storage_path, SIGNED_URL_TTL_SECONDS);
  return { ...doc, url: error ? null : data?.signedUrl ?? null };
}

/**
 * GET /api/contacts/[id]/documents
 * Team-visible (BUILD-SPEC.md "Trade insurance compliance" — not
 * financial). Response: { documents } — non-deleted, most recent
 * first, each with a freshly-signed URL. Feeds ContactsBrowser's
 * per-contact documents panel (upload/list/delete, expiry input).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [
    { data: documents, error },
    { data: latestRequest },
  ] = await Promise.all([
    supabase
      .from("contact_documents")
      .select("*")
      .eq("contact_id", contactId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase
      .from("contact_document_requests")
      .select(
        "id,requested_kinds,to_email,status,requested_at,sent_at,opened_at,completed_at,expires_at"
      )
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({
    documents: await Promise.all((documents as ContactDocument[]).map((d) => withUrl(supabase, d))),
    latest_request: (latestRequest as InsuranceRequestSummary | null) ?? null,
  });
}

/**
 * POST /api/contacts/[id]/documents
 * body: CreateContactDocumentInput — { kind, storage_path, filename,
 * expiry_date? }. Metadata-only — the file was already uploaded
 * straight to Storage via a signed upload URL (POST
 * .../documents/upload-url), bypassing the ~4.5 MB Vercel body limit,
 * same two-step pattern as POST /api/projects/[id]/files. Response:
 * { document } (201).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: contactId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: contact } = await supabase
    .from("contacts")
    .select("id")
    .eq("id", contactId)
    .is("deleted_at", null)
    .single();
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  let body: CreateContactDocumentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!KINDS.includes(body.kind)) {
    return NextResponse.json(
      {
        error:
          "kind must be one of public_liability, professional_indemnity, workers_comp, licence, other",
      },
      { status: 400 }
    );
  }
  const storage_path = typeof body.storage_path === "string" ? body.storage_path : "";
  if (!storage_path.startsWith(`contacts/${contactId}/documents/`)) {
    return NextResponse.json({ error: "Invalid storage path" }, { status: 400 });
  }
  const filename = body.filename?.trim() || "document";

  const { data: doc, error } = await supabase
    .from("contact_documents")
    .insert({
      contact_id: contactId,
      kind: body.kind,
      storage_path,
      filename,
      expiry_date: body.expiry_date || null,
      uploaded_by: user.id,
    })
    .select()
    .single();

  if (error) {
    await supabase.storage.from(ASSET_BUCKET).remove([storage_path]);
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ document: await withUrl(supabase, doc as ContactDocument) }, { status: 201 });
}
