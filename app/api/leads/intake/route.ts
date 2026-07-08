import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { reportError } from "@/lib/report-error";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import { sniffFileKind } from "@/lib/file-sniff";
import type { Lead } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/leads/intake — website enquiry webhook.
 *
 * RESLU-Spec-Lead-Intake.md (Website handoff, 8 July 2026): the new
 * reslu.com.au /begin form's Vercel function (reslu-site/api/enquiry.js)
 * POSTs every enquiry here with `Authorization: Bearer <secret>` — the
 * same random string set as CRM_WEBHOOK_SECRET on the website's Vercel
 * project and LEAD_INTAKE_SECRET on this one. Creates one row in the
 * leads pipeline (stage 'Potential Lead', source 'WEBSITE').
 *
 * MUST-KEEP fields (the spec's own words): `gclid` and the four
 * `utm_*` fields are stored verbatim on the lead — Aria's offline
 * conversion import matches a booked studio visit back to the ad
 * click via gclid; if this route dropped it, Google Ads could never
 * learn which clicks become consultations.
 *
 * Photos: the form accepts up to 3 site photos (base64 JPEG,
 * compressed client-side to well under ~1.8 MB of base64 each —
 * see enquiry.js). Each is magic-byte validated (lib/file-sniff.ts,
 * same discipline as every other upload route since fix round B),
 * uploaded to the private assets bucket, and recorded as a
 * lead_attachments row (migration 042). A bad photo never fails the
 * lead — the enquiry itself is the thing that must not be lost — it
 * is skipped and reported in the response's `photo_errors`.
 *
 * Auth mechanics: a shared bearer secret, compared exactly like the
 * CRON_SECRET routes (app/api/leads/queue-sync/route.ts). Bearer-
 * bearing /api/** requests already pass the proxy allowlist
 * (lib/supabase/middleware.ts `isBearerApiRequest`), so this handler
 * is the real gate. The route uses the service-role client: the
 * caller is a webhook, not a Supabase user, so RLS's `to
 * authenticated` policies don't apply to it — fail-closed: if
 * LEAD_INTAKE_SECRET isn't configured, every request is rejected
 * (503) rather than any comparison against an empty string.
 *
 * Rate limit: same in-memory limiter as the unauthenticated portal
 * routes (lib/rate-limit.ts) keyed by client IP — best-effort burst
 * protection on top of (never instead of) the secret check.
 */

const MAX_PHOTOS = 3;
/** Decoded-bytes cap per photo — enquiry.js clamps base64 to
 * <1.8M chars (~1.35 MB decoded); 2 MB leaves headroom without
 * letting a misbehaving caller stream us arbitrarily large files. */
const MAX_PHOTO_BYTES = 2_000_000;

const MIME_BY_KIND: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

/** Defensive length clamp — mirrors enquiry.js's own `clean()` so a
 * payload that bypassed the website function can't dump megabytes
 * into a text column. Empty strings become null (house style: every
 * optional leads text column is null, not ''). */
function clean(v: unknown, max = 500): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

interface IntakePhoto {
  filename: string;
  content: string; // base64 JPEG (data-URL prefix tolerated)
}

function parsePhotos(raw: unknown): IntakePhoto[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .slice(0, MAX_PHOTOS)
    .filter(
      (p): p is { filename?: unknown; content?: unknown } =>
        !!p && typeof p === "object"
    )
    .map((p, i) => ({
      filename:
        (typeof p.filename === "string" &&
          slugFilename(p.filename).slice(0, 120)) ||
        `photo-${i + 1}.jpg`,
      content: typeof p.content === "string" ? p.content : "",
    }))
    .filter((p) => p.content.length > 0);
}

export async function POST(request: NextRequest) {
  const secret = process.env.LEAD_INTAKE_SECRET;
  if (!secret) {
    // Fail closed, loudly — a misconfigured deploy should show up in
    // app_errors, not silently 401 the website's enquiries.
    await reportError(
      "lead-intake",
      "LEAD_INTAKE_SECRET is not set — rejecting website enquiry"
    );
    return NextResponse.json({ error: "Not configured" }, { status: 503 });
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const limit = rateLimit(`lead-intake:${clientIp(request)}`, 10, 60_000);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Same two checks as the spec's reference route: a payload that
  // isn't a lead, or has no email, is malformed — reject.
  const email = clean(body.email, 160);
  if (body.type !== "lead" || !email || !email.includes("@")) {
    return NextResponse.json({ error: "invalid" }, { status: 400 });
  }

  const firstName = clean(body.first_name, 80);
  const lastName = clean(body.last_name, 80);
  const projectType = clean(body.project_type, 60);

  // House card-name convention (014: "surname_project"): Surname_Project,
  // falling back to whatever identity we have so the card is never blank.
  const surname = lastName || firstName || email.split("@")[0];
  const surnameProject = `${surname}_${projectType || "Enquiry"}`.slice(0, 120);

  const receivedRaw = clean(body.received_at, 40);
  const receivedAt =
    receivedRaw && !Number.isNaN(new Date(receivedRaw).getTime())
      ? new Date(receivedRaw).toISOString()
      : new Date().toISOString();

  const message = clean(body.message, 4000);

  const supabase = createServiceRoleClient();

  const { data: lead, error: insertError } = await supabase
    .from("leads")
    .insert({
      surname_project: surnameProject,
      first_name: firstName,
      source: "WEBSITE",
      stage: "Potential Lead",
      email,
      phone: clean(body.phone, 40),
      location: clean(body.suburb, 80),
      received_at: receivedAt,
      // Verbatim intake payload (migration 042). gclid + utm_* are the
      // spec's MUST-KEEP fields — see route header.
      project_type: projectType,
      message,
      page: clean(body.page, 200),
      gclid: clean(body.gclid, 200),
      utm_source: clean(body.utm_source, 100),
      utm_medium: clean(body.utm_medium, 100),
      utm_campaign: clean(body.utm_campaign, 150),
      utm_content: clean(body.utm_content, 150),
      created_by: null, // webhook — no app user behind it
    })
    .select()
    .single();

  if (insertError || !lead) {
    await reportError("lead-intake", insertError ?? "insert returned no row");
    return NextResponse.json(
      { error: insertError?.message ?? "Insert failed" },
      { status: 500 }
    );
  }

  const created = lead as Lead;

  // Surface the enquiry message in the attributed notes feed (the
  // panel's only notes surface since migration 030) — non-fatal.
  if (message) {
    const { error: noteError } = await supabase.from("lead_notes").insert({
      lead_id: created.id,
      author_id: null,
      author_name: "Website enquiry",
      text: message,
    });
    if (noteError) await reportError("lead-intake", noteError);
  }

  // Photos → private assets bucket + lead_attachments rows. Sequential
  // (max 3), per-photo error accounting — same pattern as the
  // site-photos upload loop. A photo failure never fails the lead.
  const photos = parsePhotos(body.photos);
  const photoErrors: string[] = [];
  let photosStored = 0;

  for (const [i, photo] of photos.entries()) {
    try {
      const b64 = photo.content.replace(/^data:[^;]+;base64,/, "");
      const bytes = Buffer.from(b64, "base64");
      if (bytes.length === 0) {
        photoErrors.push(`${photo.filename}: empty or undecodable base64`);
        continue;
      }
      if (bytes.length > MAX_PHOTO_BYTES) {
        photoErrors.push(`${photo.filename}: exceeds ${MAX_PHOTO_BYTES} bytes`);
        continue;
      }
      const kind = sniffFileKind(bytes);
      const mime = MIME_BY_KIND[kind];
      if (!mime) {
        photoErrors.push(
          `${photo.filename}: doesn't look like a valid JPEG, PNG, or WebP image.`
        );
        continue;
      }

      const path = `leads/${created.id}/intake/${Date.now()}-${i + 1}-${photo.filename}`;
      const { error: uploadError } = await supabase.storage
        .from(ASSET_BUCKET)
        .upload(path, bytes, { contentType: mime, upsert: false });
      if (uploadError) {
        photoErrors.push(`${photo.filename}: ${uploadError.message}`);
        continue;
      }

      const { error: rowError } = await supabase.from("lead_attachments").insert({
        lead_id: created.id,
        filename: photo.filename,
        storage_path: path,
        mime,
        size_bytes: bytes.length,
        source: "intake",
      });
      if (rowError) {
        // Keep storage consistent with the table, same as site-photos.
        await supabase.storage.from(ASSET_BUCKET).remove([path]);
        photoErrors.push(`${photo.filename}: ${rowError.message}`);
        continue;
      }

      photosStored += 1;
    } catch (err) {
      await reportError("lead-intake", err);
      photoErrors.push(`${photo.filename}: unexpected error`);
    }
  }

  if (photoErrors.length > 0) {
    await reportError(
      "lead-intake",
      `lead ${created.id}: ${photoErrors.join("; ")}`
    );
  }

  return NextResponse.json(
    {
      ok: true,
      lead_id: created.id,
      photos_stored: photosStored,
      ...(photoErrors.length > 0 ? { photo_errors: photoErrors } : {}),
    },
    { status: 201 }
  );
}
