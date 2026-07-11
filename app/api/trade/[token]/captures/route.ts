import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired } from "@/lib/trade-visits";
import { isSniffedImage } from "@/lib/file-sniff";
import { captureStoragePath, SITE_CAPTURES_BUCKET, withCaptureUrl } from "@/lib/site-captures";

export const runtime = "nodejs";

/**
 * POST /api/trade/[token]/captures
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 1b/3.
 * Public, unauthenticated — token-gated (confirm_token), same trust
 * model as POST /api/trade/[token]/respond: rate-limited 10/min
 * (keyed by token+IP, same limit/window), service-role client
 * (bypasses RLS — this is not an authenticated team session), and the
 * visit's expiry is re-checked HERE independently of the page (a
 * direct POST after expiry must not succeed even if the page is
 * bypassed) — see that route's own doc comment for why.
 *
 * No new token infra: `token` is trade_visits.confirm_token, the SAME
 * token /trade/[token] already renders under. project_id,
 * trade_visit_id, and author_contact_id are ALL resolved server-side
 * from the visit the token identifies — never accepted from the
 * request body — so a trade can only ever write a capture against the
 * one project/visit their own link points at, and is always
 * attributed as the visit's own contact (the CHECK
 * chk_site_captures_one_author on site_captures requires exactly one
 * of author_user_id/author_contact_id — this path always sets
 * author_contact_id, never author_user_id, migration 050).
 *
 * Same two request shapes as POST /api/site-captures (multipart for
 * photo/audio, JSON for note) — see that route's doc comment for the
 * full upload/validation walkthrough, mirrored here byte-for-byte
 * except for how project_id/author are sourced.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-captures:${token}:${clientIp}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("id,project_id,contact_id,end_date,status,confirm_token,deleted_at")
    .eq("confirm_token", token)
    .maybeSingle();

  if (!visit) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isVisitExpired(visit)) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }
  if (!visit.contact_id) {
    return NextResponse.json({ error: "This visit has no trade contact on file." }, { status: 400 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "Expected form data" }, { status: 400 });
    }

    const kindRaw = form.get("kind");
    const file = form.get("file");
    if (kindRaw !== "photo" && kindRaw !== "audio") {
      return NextResponse.json(
        { error: "kind must be 'photo' or 'audio' for a file upload — use JSON for a note" },
        { status: 400 }
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    // Cast, not relied-on narrowing — same reasoning as POST
    // /api/site-captures: TS can't express "string minus these two
    // literals" on the plain `string` member of kindRaw's
    // File | string | null union, so the guard above proves this at
    // runtime without the compiler inferring it structurally.
    const kind = kindRaw as "photo" | "audio";
    const bytes = Buffer.from(await file.arrayBuffer());

    if (kind === "photo" && !isSniffedImage(bytes)) {
      return NextResponse.json(
        { error: "That doesn't look like a valid JPEG, PNG, or WebP image — the file may be corrupted or mislabelled." },
        { status: 400 }
      );
    }
    if (kind === "audio" && bytes.length === 0) {
      return NextResponse.json({ error: "Empty audio recording." }, { status: 400 });
    }

    const path = captureStoragePath(visit.project_id, kind, file.name || kind);
    const { error: uploadError } = await supabase.storage.from(SITE_CAPTURES_BUCKET).upload(path, bytes, {
      contentType: file.type || (kind === "photo" ? "image/jpeg" : "audio/mp4"),
      upsert: false,
    });
    if (uploadError) {
      return NextResponse.json({ error: uploadError.message }, { status: 500 });
    }

    const { data: row, error: insertError } = await supabase
      .from("site_captures")
      .insert({
        project_id: visit.project_id,
        kind,
        storage_path: path,
        author_contact_id: visit.contact_id,
        trade_visit_id: visit.id,
        transcript_status: kind === "audio" ? "pending" : null,
      })
      .select()
      .single();

    if (insertError) {
      await supabase.storage.from(SITE_CAPTURES_BUCKET).remove([path]);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }

    return NextResponse.json({ capture: await withCaptureUrl(supabase, row) }, { status: 201 });
  }

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { kind, text_content } = body as { kind?: string; text_content?: string };
  if (kind !== "note") {
    return NextResponse.json(
      { error: "JSON POST only supports kind 'note' — use multipart/form-data for photo/audio." },
      { status: 400 }
    );
  }
  const trimmed = typeof text_content === "string" ? text_content.trim() : "";
  if (!trimmed) {
    return NextResponse.json({ error: "text_content is required" }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from("site_captures")
    .insert({
      project_id: visit.project_id,
      kind: "note",
      text_content: trimmed,
      author_contact_id: visit.contact_id,
      trade_visit_id: visit.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ capture: await withCaptureUrl(supabase, row) }, { status: 201 });
}
