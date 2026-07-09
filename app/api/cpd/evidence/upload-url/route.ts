import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import type { CpdEvidenceUploadUrlResponse } from "@/types/cpd";

export const runtime = "nodejs";

/**
 * POST /api/cpd/evidence/upload-url
 * body: { filename }
 *
 * Mints a short-lived signed upload URL so the browser can PUT a CPD
 * evidence file (certificate, confirmation email PDF, screenshot)
 * DIRECTLY to Supabase Storage — same two-step signed-upload pattern as
 * POST /api/contacts/[id]/documents/upload-url. Keyed by the caller's
 * OWN user_id (`cpd/{user_id}/...`), not by a cpd_entries row id,
 * because — unlike contact_documents — a CPD entry doesn't exist yet at
 * upload time (the add form uploads evidence BEFORE the entry is
 * created, then includes the resulting `path` directly in the POST
 * /api/cpd body). POST /api/cpd and PATCH /api/cpd/[id] both re-check
 * that any evidence_path they're given actually starts with
 * `cpd/{owning user's id}/`, so a forged path from another user's
 * folder is rejected there.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const filename =
    body && typeof body.filename === "string" && body.filename.trim() ? body.filename.trim() : "evidence";

  const path = `cpd/${user.id}/${Date.now()}-${slugFilename(filename)}`;

  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
  if (error) {
    return NextResponse.json(
      { error: `${error.message}. If this mentions a missing bucket, run migration 009.` },
      { status: 500 }
    );
  }

  const payload: CpdEvidenceUploadUrlResponse = { path: data.path, token: data.token };
  return NextResponse.json(payload);
}
