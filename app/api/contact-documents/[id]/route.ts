import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import type { PatchContactDocumentInput } from "@/lib/insurance";

export const runtime = "nodejs";

/**
 * PATCH /api/contact-documents/[id]
 * body: PatchContactDocumentInput — { expiry_date?, verified_at? }.
 * The two fields a team member edits after upload without needing to
 * delete/re-upload: correcting an expiry date, or marking a document
 * verified (verified_at — stamped by the API from a boolean-ish intent
 * in the body: passing any truthy value sets it to now(), passing null
 * clears it, matching the simple "verify" checkbox ContactsBrowser's
 * documents panel exposes).
 */
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

  let body: PatchContactDocumentInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  if ("expiry_date" in body) {
    update.expiry_date = body.expiry_date || null;
  }
  if ("verified_at" in body) {
    update.verified_at = body.verified_at === null ? null : body.verified_at || new Date().toISOString();
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: document, error } = await supabase
    .from("contact_documents")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json({ document });
}

/**
 * DELETE /api/contact-documents/[id]
 * Soft-deletes the row (deleted_at) — kept rather than hard-deleted
 * because insurance-compliance history has audit value (e.g. "was
 * this trade covered on the day of their visit six months ago") — but
 * ALSO removes the underlying Storage object immediately, same as
 * DELETE /api/item-files/[fileId] (unlike project_files' pure
 * soft-delete-only semantics). The row survives (excluded from every
 * listing/status-computation query via `is("deleted_at", null)`) so
 * historical insurance_status computations and any future audit trail
 * still resolve the id, while the actual PDF/image stops taking up
 * bucket storage — a deleted insurance certificate has no reason to
 * keep its file retrievable the way a still-referenced spec document
 * might.
 */
export async function DELETE(
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

  const { data: existing } = await supabase
    .from("contact_documents")
    .select("storage_path")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("contact_documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  await supabase.storage.from(ASSET_BUCKET).remove([existing.storage_path]);

  return NextResponse.json({ ok: true });
}
