import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { cleanCpdEntryFields } from "@/lib/cpd";
import type { CpdEntry, PatchCpdEntryInput } from "@/types/cpd";

export const runtime = "nodejs";

const EDITABLE_FIELDS = new Set([
  "activity_title",
  "provider",
  "activity_date",
  "points",
  "category",
  "notes",
]);

/**
 * PATCH /api/cpd/[id]
 * Auth: session, OWN entry only — UNLESS the caller is admin, who may
 * edit any team member's entry (documented in migration 047's own RLS
 * comment: "admins may write/view any user's rows"). The ownership
 * check below is the real gate (RLS is the house-standard permissive
 * team_all) — a forged id belonging to someone else's entry 404s for a
 * non-admin rather than ever being readable/writable here, same
 * enforcement shape as PATCH /api/my-work/notes/[id].
 *
 * body: PatchCpdEntryInput (partial). Passing evidence_path: null
 * clears any existing evidence AND removes the underlying Storage
 * object; passing a NEW evidence_path (from the signed-upload flow)
 * replaces it, removing the old object once the row update succeeds.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, role } = info;
  const isAdmin = role === "admin";

  const { data: existing } = await supabase
    .from("cpd_entries")
    .select("id,user_id,evidence_path")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing || (!isAdmin && existing.user_id !== userId)) {
    return NextResponse.json({ error: "CPD entry not found" }, { status: 404 });
  }

  let body: PatchCpdEntryInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fieldSubset: Record<string, unknown> = {};
  for (const key of Object.keys(body)) {
    if (EDITABLE_FIELDS.has(key)) fieldSubset[key] = (body as Record<string, unknown>)[key];
  }
  let update: Record<string, unknown> = {};
  if (Object.keys(fieldSubset).length > 0) {
    // cleanCpdEntryFields requires the three "always required" fields
    // to be present to validate — for a partial PATCH, backfill from
    // the existing row's own values first so e.g. "just change points"
    // still validates cleanly without the caller re-sending everything.
    const { data: currentFull } = await supabase
      .from("cpd_entries")
      .select("activity_title,provider,activity_date,points,category,notes")
      .eq("id", id)
      .single();
    const merged = { ...currentFull, ...fieldSubset };
    const clean = cleanCpdEntryFields(merged);
    if (!clean) {
      return NextResponse.json(
        { error: "activity_title, activity_date (YYYY-MM-DD) and points (> 0) are required" },
        { status: 400 }
      );
    }
    update = { ...clean };
  }

  let removeOldEvidence = false;
  if ("evidence_path" in body) {
    if (body.evidence_path === null) {
      update.evidence_path = null;
      update.evidence_filename = null;
      removeOldEvidence = !!existing.evidence_path;
    } else if (
      typeof body.evidence_path === "string" &&
      // Accepts a path scoped to the entry owner's own folder (the
      // common case), OR — if the caller is admin editing someone
      // else's entry — a path scoped to the ADMIN's own folder. The
      // upload-url route always mints a path under the CALLER's id
      // (cpd/{user.id}/...), so an admin attaching evidence to a
      // teammate's entry gets a path that never matches
      // `cpd/${existing.user_id}/` — without this, that evidence_path
      // silently failed to attach (or the request 400'd with "Nothing
      // to update" if evidence was the only change), orphaning the
      // uploaded file in Storage forever.
      (body.evidence_path.startsWith(`cpd/${existing.user_id}/`) ||
        (isAdmin && body.evidence_path.startsWith(`cpd/${userId}/`)))
    ) {
      update.evidence_path = body.evidence_path;
      update.evidence_filename =
        typeof body.evidence_filename === "string" && body.evidence_filename.trim()
          ? body.evidence_filename.trim()
          : "evidence";
      removeOldEvidence = !!existing.evidence_path && existing.evidence_path !== body.evidence_path;
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from("cpd_entries")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    const status = error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  if (removeOldEvidence && existing.evidence_path) {
    await supabase.storage.from(ASSET_BUCKET).remove([existing.evidence_path]);
  }

  const { data: profile } = await supabase.from("profiles").select("id,full_name").eq("id", row.user_id).maybeSingle();

  let evidence_url: string | null = null;
  if (row.evidence_path) {
    const { data: signed, error: signErr } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(row.evidence_path, SIGNED_URL_TTL_SECONDS);
    evidence_url = signErr ? null : signed?.signedUrl ?? null;
  }

  const entry: CpdEntry = { ...(row as Omit<CpdEntry, "evidence_url" | "profile">), evidence_url, profile: profile ?? null };
  return NextResponse.json({ entry });
}

/**
 * DELETE /api/cpd/[id]
 * Auth: session, OWN entry only — UNLESS admin (same gate as PATCH
 * above). Soft-deletes the row (deleted_at) AND removes any evidence
 * Storage object immediately — same "soft-delete the row, hard-delete
 * the file" shape as DELETE /api/contact-documents/[id] (a deleted CPD
 * log entry has no ongoing reason to keep its certificate retrievable,
 * while the row itself survives for any future audit trail).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, role } = info;
  const isAdmin = role === "admin";

  const { data: existing } = await supabase
    .from("cpd_entries")
    .select("id,user_id,evidence_path")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing || (!isAdmin && existing.user_id !== userId)) {
    return NextResponse.json({ error: "CPD entry not found" }, { status: 404 });
  }

  const { error } = await supabase
    .from("cpd_entries")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (existing.evidence_path) {
    await supabase.storage.from(ASSET_BUCKET).remove([existing.evidence_path]);
  }

  return NextResponse.json({ ok: true });
}
