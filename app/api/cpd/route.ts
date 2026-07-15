import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { FALLBACK_CPD_DEFAULTS, cleanCpdEntryFields, computeCpdYearWindow } from "@/lib/cpd";
import type { CpdDefaults, CpdEntry, CpdListResponse, CreateCpdEntryInput } from "@/types/cpd";

export const runtime = "nodejs";

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** Mints a fresh signed URL for an entry's evidence file (private `assets` bucket) — same per-request-mint pattern as GET /api/contacts/[id]/documents's withUrl(), never a stored/cached URL. */
async function withEvidenceUrl(
  supabase: SupabaseServerClient,
  row: Omit<CpdEntry, "evidence_url">
): Promise<CpdEntry> {
  if (!row.evidence_path) return { ...row, evidence_url: null };
  const { data, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(row.evidence_path, SIGNED_URL_TTL_SECONDS);
  return { ...row, evidence_url: error ? null : data?.signedUrl ?? null };
}

/**
 * GET /api/cpd
 * Auth: session. Default response is the SIGNED-IN user's own,
 * non-deleted entries for the current CPD licence-year window (see
 * lib/cpd.ts computeCpdYearWindow), most recent first, alongside the
 * studio's cpd_defaults and the resolved window itself so the page
 * never has to separately fetch Settings to render its header.
 *
 * ?all=1 (admin only): every team member's entries for the same
 * window, each carrying a `profile` projection so the "All team" view
 * can group by person client-side. A non-admin passing ?all=1 is
 * SILENTLY ignored (falls back to their own entries, `all: false` in
 * the response) rather than 403ing — the query param is a UI toggle
 * hint, not a security boundary the client is trusted to enforce; the
 * actual gate is this check, matching this codebase's usual "belt and
 * braces" shape (the UI also hides the toggle from non-admins, see
 * components/cpd/CpdWorkspace.tsx).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, role } = info;
  const isAdmin = role === "admin";
  const wantsAll = new URL(request.url).searchParams.get("all") === "1";
  const showAll = isAdmin && wantsAll;

  const [{ data: defaultsRow }, { data: currentProfile }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "cpd_defaults").maybeSingle(),
    supabase.from("profiles").select("id,full_name").eq("id", userId).maybeSingle(),
  ]);
  const defaults = (defaultsRow?.value as CpdDefaults | undefined) ?? FALLBACK_CPD_DEFAULTS;
  const window = computeCpdYearWindow(new Date(), defaults.year_start_month);

  let query = supabase
    .from("cpd_entries")
    .select("*")
    .is("deleted_at", null)
    .gte("activity_date", window.start)
    .lte("activity_date", window.end)
    .order("activity_date", { ascending: false })
    .order("created_at", { ascending: false });

  if (!showAll) {
    query = query.eq("user_id", userId);
  }

  const { data: rows, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const userIds = [...new Set((rows ?? []).map((r) => r.user_id as string))];
  const { data: profileRows } = userIds.length
    ? await supabase.from("profiles").select("id,full_name").in("id", userIds)
    : { data: [] as { id: string; full_name: string }[] };
  const profileById = new Map((profileRows ?? []).map((p) => [p.id, p]));

  const entries = await Promise.all(
    (rows ?? []).map((row) =>
      withEvidenceUrl(supabase, {
        ...(row as Omit<CpdEntry, "evidence_url" | "profile">),
        profile: profileById.get(row.user_id as string) ?? null,
      })
    )
  );

  const body: CpdListResponse = {
    entries,
    defaults,
    window,
    current_user: {
      id: userId,
      full_name: currentProfile?.full_name?.trim() || "My",
    },
    is_admin: isAdmin,
    all: showAll,
  };
  return NextResponse.json(body);
}

/**
 * POST /api/cpd
 * Auth: session. body: CreateCpdEntryInput. Always writes with the
 * caller's OWN user_id UNLESS the caller is admin and passes a
 * `user_id` — the one deliberate escape hatch, used by the
 * add_cpd_entry MCP tool (Aria's account is admin) to log an activity
 * on behalf of a team member she's resolved from a confirmation-email
 * address, never by the ordinary CPD page UI (which never sends
 * user_id at all — every regular team member can only ever create
 * their own rows). A non-admin's `user_id` field, if somehow present in
 * the body, is silently ignored (forced to their own id) rather than
 * erroring — same "ignore, don't 403, on an untrusted extra field"
 * shape GET's ?all=1 handling above uses.
 *
 * If `user_id` IS supplied by an admin, it's validated against
 * `profiles` first (a 400, not a foreign-key 500, on a bad id).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, role } = info;
  const isAdmin = role === "admin";

  let body: CreateCpdEntryInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const clean = cleanCpdEntryFields(body);
  if (!clean) {
    return NextResponse.json(
      { error: "activity_title, activity_date (YYYY-MM-DD) and points (> 0) are required" },
      { status: 400 }
    );
  }

  let targetUserId = userId;
  if (isAdmin && typeof body.user_id === "string" && body.user_id.trim()) {
    const { data: targetProfile } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", body.user_id.trim())
      .maybeSingle();
    if (!targetProfile) {
      return NextResponse.json({ error: "user_id does not match a known team member" }, { status: 400 });
    }
    targetUserId = targetProfile.id;
  }

  const evidence_path =
    typeof body.evidence_path === "string" &&
    // Same admin-uploads-on-someone-else's-behalf gap as PATCH
    // /api/cpd/[id] — the upload-url route always mints a path under
    // the CALLER's own id, so an admin creating an entry for a
    // teammate (targetUserId !== caller's userId) needs their own-
    // folder path accepted too, not just the target's.
    (body.evidence_path.startsWith(`cpd/${targetUserId}/`) ||
      (isAdmin && body.evidence_path.startsWith(`cpd/${userId}/`)))
      ? body.evidence_path
      : null;
  const evidence_filename = evidence_path && typeof body.evidence_filename === "string"
    ? body.evidence_filename.trim() || "evidence"
    : null;

  const { data: row, error } = await supabase
    .from("cpd_entries")
    .insert({
      user_id: targetUserId,
      ...clean,
      evidence_path,
      evidence_filename,
    })
    .select()
    .single();

  if (error) {
    if (evidence_path) await supabase.storage.from(ASSET_BUCKET).remove([evidence_path]);
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  const { data: profile } = await supabase.from("profiles").select("id,full_name").eq("id", targetUserId).maybeSingle();

  const entry = await withEvidenceUrl(supabase, {
    ...(row as Omit<CpdEntry, "evidence_url" | "profile">),
    profile: profile ?? null,
  });

  return NextResponse.json({ entry }, { status: 201 });
}
