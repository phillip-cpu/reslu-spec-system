import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isSniffedImage } from "@/lib/file-sniff";
import { captureStoragePath, SITE_CAPTURES_BUCKET, withCaptureUrl } from "@/lib/site-captures";

export const runtime = "nodejs";

/**
 * POST /api/site-captures
 * Site capture + mobile QoL round (r21), BUILD-SPEC.md item 3.
 * Authenticated team member (/capture) — author_user_id = the caller,
 * author_contact_id/trade_visit_id stay null (the CHECK
 * chk_site_captures_one_author on site_captures requires exactly one
 * of author_user_id/author_contact_id, migration 050).
 *
 * Two request shapes, dispatched on Content-Type:
 *   - multipart/form-data: fields `project_id`, `kind` ('photo' or
 *     'audio'), `file` — uploads `file` into the private
 *     `site-captures` bucket, mirrors POST
 *     /api/projects/[id]/site-photos' multipart upload shape exactly
 *     (Buffer.from(arrayBuffer()) -> supabase.storage.upload ->
 *     insert row -> remove the object again if the insert fails).
 *     Photo bytes are magic-byte validated (lib/file-sniff.ts), same
 *     as every other image upload route in this codebase. Audio has
 *     no sniffer signature in this codebase (MediaRecorder's
 *     audio/mp4 / audio/webm output isn't one of the formats
 *     lib/file-sniff.ts knows) so it's only checked for non-zero
 *     length; audio/note kind is trusted the same way every other
 *     upload route trusts its claimed Content-Type once a real byte
 *     length is confirmed.
 *   - application/json: { project_id, kind: 'note', text_content } —
 *     no storage upload, plain text row.
 *
 * Audio rows are inserted with transcript_status='pending' — the
 * queue app/api/site-captures/pending-transcriptions/route.ts (and the
 * MCP list_pending_transcriptions tool) polls.
 *
 * Response: { capture } (SiteCaptureWithUrl, 201).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "Expected form data" }, { status: 400 });
    }

    const projectIdRaw = form.get("project_id");
    const kindRaw = form.get("kind");
    const file = form.get("file");

    if (typeof projectIdRaw !== "string" || !projectIdRaw) {
      return NextResponse.json({ error: "project_id is required" }, { status: 400 });
    }
    if (kindRaw !== "photo" && kindRaw !== "audio") {
      return NextResponse.json(
        { error: "kind must be 'photo' or 'audio' for a file upload — use JSON for a note" },
        { status: 400 }
      );
    }
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file is required" }, { status: 400 });
    }

    const projectId = projectIdRaw;
    // Cast, not relied-on narrowing: TS's equality-narrowing can't
    // express "string minus these two literals" on a plain `string`
    // member of a wider union (kindRaw: File | string | null from
    // form.get()), so the guard above proves this at runtime without
    // the compiler being able to infer it structurally.
    const kind = kindRaw as "photo" | "audio";

    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .maybeSingle();
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

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

    const path = captureStoragePath(projectId, kind, file.name || kind);
    const { error: uploadError } = await supabase.storage.from(SITE_CAPTURES_BUCKET).upload(path, bytes, {
      contentType: file.type || (kind === "photo" ? "image/jpeg" : "audio/mp4"),
      upsert: false,
    });
    if (uploadError) {
      return NextResponse.json(
        { error: `${uploadError.message}. If this mentions a missing bucket, run migration 050.` },
        { status: 500 }
      );
    }

    const { data: row, error: insertError } = await supabase
      .from("site_captures")
      .insert({
        project_id: projectId,
        kind,
        storage_path: path,
        author_user_id: user.id,
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

  // JSON body — notes only.
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { project_id, kind, text_content } = body as {
    project_id?: string;
    kind?: string;
    text_content?: string;
  };

  if (!project_id) {
    return NextResponse.json({ error: "project_id is required" }, { status: 400 });
  }
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

  const { data: project } = await supabase.from("projects").select("id").eq("id", project_id).maybeSingle();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: row, error } = await supabase
    .from("site_captures")
    .insert({ project_id, kind: "note", text_content: trimmed, author_user_id: user.id })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ capture: await withCaptureUrl(supabase, row) }, { status: 201 });
}
