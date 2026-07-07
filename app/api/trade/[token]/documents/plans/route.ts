import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired } from "@/lib/trade-visits";
import { latestPlansFile } from "@/lib/trade-doc-pack";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";

export const runtime = "nodejs";

/**
 * GET /api/trade/[token]/documents/plans
 *
 * Tokened proxy for a trade's booking-page Plans document (BUILD-
 * SPEC.md "Trade booking document pack" item 3) — redirects to a
 * freshly-minted, short-TTL signed URL for the project's CURRENT
 * latest Plans revision (resolved fresh every request per
 * lib/trade-doc-pack.ts's own "frozen choices, live revisions"
 * resolution semantics — see that file's header comment).
 *
 * Unlike the schedule/SOW proxies (both generated PDFs this app
 * renders on demand), a Plans document is an already-uploaded Storage
 * object (project_files.storage_path) — there is nothing to render,
 * so this route's whole job is: validate the token + pack choice, find
 * the current latest revision, mint a signed URL, and hand the trade
 * straight to it via a redirect rather than proxying the bytes through
 * this function (a plans PDF can be large; redirecting to Supabase
 * Storage's own CDN is strictly cheaper than this function reading and
 * re-streaming every byte itself).
 *
 * TOKEN GATING — identical shape to the schedule/SOW proxies (see
 * those files' own doc comments for the fuller rationale): rate
 * limited by token+IP, confirm_token must resolve to a real
 * non-deleted visit, isVisitExpired() re-checked independently,
 * document_pack.include_plans must be true (a visit whose pack never
 * included Plans 404s here regardless of the visit's own validity).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-doc-plans:${token}:${clientIp}`);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("id,project_id,end_date,deleted_at,document_pack")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!visit) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isVisitExpired(visit)) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  const pack = visit.document_pack as { include_plans?: boolean } | null;
  if (!pack?.include_plans) {
    return NextResponse.json({ error: "No plans were included with this booking." }, { status: 404 });
  }

  const { data: files } = await supabase
    .from("project_files")
    .select("id,storage_path,filename,revision_label,uploaded_at")
    .eq("project_id", visit.project_id)
    .eq("kind", "plans")
    .is("deleted_at", null);

  const latest = latestPlansFile(files ?? []);
  if (!latest) {
    // The pack ticked Plans at booking time, but every plans revision
    // has since been removed — nothing to serve. Per this round's own
    // "never a broken/404 link shown to the trade" resolution
    // semantics, the trade PAGE simply omits this row when this
    // happens; a direct hit on the proxy endpoint itself still needs
    // SOME response, and 404 (not a redirect to nowhere) is correct
    // here.
    return NextResponse.json({ error: "No plans are currently available for this project." }, { status: 404 });
  }

  // SIGNED_URL_TTL_SECONDS (1 hour — lib/storage.ts) is this codebase's
  // one existing signed-URL TTL constant, reused here rather than a
  // second bespoke duration — matches this round's own "short TTL
  // (~1h)" requirement exactly.
  const { data: signed, error } = await supabase.storage
    .from(ASSET_BUCKET)
    .createSignedUrl(latest.storage_path, SIGNED_URL_TTL_SECONDS);
  if (error || !signed?.signedUrl) {
    return NextResponse.json({ error: "Could not open the plans document." }, { status: 500 });
  }

  return NextResponse.redirect(signed.signedUrl);
}
