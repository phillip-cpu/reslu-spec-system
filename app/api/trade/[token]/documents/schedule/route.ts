import { createHash } from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { headers } from "next/headers";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired } from "@/lib/trade-visits";
import { ensureStoredImagesForItems } from "@/lib/images";
import { ASSET_BUCKET } from "@/lib/storage";
import { SchedulePdf } from "@/components/pdf/SchedulePdf";
import type { Category, Item } from "@/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Identical safe field list to GET /api/projects/[id]/pdf's own
// PDF_ITEM_FIELDS — kept as a SEPARATE literal (not imported from that
// route file, which exports nothing — route files only export
// GET/POST/etc.) rather than lifted into a shared lib module in this
// round, since drifting the two lists apart would be an easy, high-
// consequence mistake (accidentally reintroducing a pricing column
// into the one PDF a trade can reach) — this file's own verification
// note below flags the two lists as needing to be checked
// letter-for-letter identical any time either route's field list
// changes.
//
// VERIFICATION NOTE (read before ever editing either list): this array
// MUST stay letter-for-letter identical to
// app/api/projects/[id]/pdf/route.ts's PDF_ITEM_FIELDS — both are the
// single safety boundary between "spec sheet" and "priced schedule."
// Neither list includes cost_price/sell_price/markup or any other
// pricing column that exists on `items` — this is the same
// explicit-allowlist-over-select(*) discipline that route's own doc
// comment describes.
const PDF_ITEM_FIELDS = [
  "id",
  "item_code",
  "category",
  "name",
  "description",
  "supplier",
  "brand",
  "quantity",
  "unit",
  "location",
  "application_note",
  "colour",
  "material",
  "finish",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "status",
  "selected_image_url",
].join(",");

const PDF_CACHE_PREFIX = "pdf-cache";

/**
 * GET /api/trade/[token]/documents/schedule
 *
 * Tokened proxy for a trade's own booking-page schedule PDF (BUILD-
 * SPEC.md "Trade booking document pack" item 3) — streams the exact
 * same spec-view schedule GET /api/projects/[id]/pdf renders for the
 * team, filtered to this visit's FROZEN document_pack.schedule_categories
 * choice, but reachable WITHOUT a team session (the trade has none).
 *
 * TOKEN GATING (every check re-derived independently of the trade
 * page component, same discipline POST /api/trade/[token]/respond's
 * own doc comment establishes — "a direct GET after expiry must not
 * succeed even if the page is bypassed"):
 *   1. Rate-limited by token+IP (same 30/min default as the page GET
 *      — this is a read, not a mutation, so it does not need
 *      respond's tighter 10/min).
 *   2. confirm_token must resolve to a real, non-deleted trade_visits
 *      row (visit -> project match is implicit: the query is BY the
 *      visit's own token, there is no separate project_id to
 *      cross-check against — unlike a hypothetical "any doc for this
 *      project" endpoint, this route can only ever resolve the ONE
 *      project the token's own visit belongs to).
 *   3. isVisitExpired() re-checked here (deleted_at / past end_date) —
 *      an expired visit's booking page shows ExpiredNotice and no
 *      DOCUMENTS section, but a direct proxy request must independently
 *      refuse too.
 *   4. document_pack must be present AND include_plans/schedule truthy
 *      as appropriate — "only pack-selected docs reachable" (this
 *      round's own verification requirement): a visit with no pack, or
 *      a pack that ticked Plans/SOW but not Schedule, 404s this
 *      specific endpoint even though the visit itself is valid and
 *      unexpired.
 *
 * CACHE REUSE: computes the SAME cache key shape as GET
 * /api/projects/[id]/pdf (project id + items max(updated_at)/count +
 * job_number + `cats:` category set — no revision/subtitle/docs
 * params, which this endpoint never sets, and no `docs:` component
 * either since this proxy never bundles item documents) so a schedule
 * already rendered/cached via the team-facing PDF route or the export
 * dialog for the SAME category set is served straight from Storage
 * with no re-render — a trade opening their booking page after a team
 * member already opened/exported the identical schedule costs nothing
 * beyond a Storage read. A cache miss renders fresh here, using the
 * exact same safe field list and image pre-pass as the team route.
 *
 * Signed URLs are NOT used for this endpoint's own response — the PDF
 * bytes are streamed directly (same as the team-facing route), which
 * is simpler and avoids minting a signed URL that would then need its
 * own separate expiry story. The "signed URLs minted per request,
 * short TTL" requirement applies to the trade PAGE's links to this
 * proxy in a different sense: this endpoint itself IS the short-lived,
 * per-request-authorized access path (gated by the token + pack check
 * on every call, not a cached signed URL) — see this round's build
 * report for the full "why a proxy stream instead of a signed URL"
 * design note.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-doc-schedule:${token}:${clientIp}`);
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

  const pack = visit.document_pack as { schedule_categories?: string[] | null } | null;
  // "only pack-selected docs reachable" — a visit whose pack never
  // included the schedule (no document_pack at all, or one that ticked
  // Plans/SOW but left Schedule unticked) has NOTHING for this specific
  // endpoint to serve, regardless of the visit's own validity.
  if (!pack || pack.schedule_categories === undefined) {
    return NextResponse.json({ error: "No schedule was included with this booking." }, { status: 404 });
  }
  const scheduleCategories = pack.schedule_categories; // string[] | null — null means full schedule, per DocumentPackChoices' own convention.

  const projectId = visit.project_id as string;
  const uniqueSelectedCategories = scheduleCategories
    ? [...new Set(scheduleCategories.map((c) => c.trim().toUpperCase()).filter(Boolean))]
    : [];
  const hasCategories = uniqueSelectedCategories.length > 0;

  let keyQuery = supabase
    .from("items")
    .select("updated_at")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  if (hasCategories) keyQuery = keyQuery.in("category", uniqueSelectedCategories);
  const { data: keyRows } = await keyQuery.order("updated_at", { ascending: false }).limit(1);
  const maxUpdatedAt = keyRows?.[0]?.updated_at ?? "epoch";

  let countQuery = supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .is("deleted_at", null);
  if (hasCategories) countQuery = countQuery.in("category", uniqueSelectedCategories);
  const { count: itemCount } = await countQuery;

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name,address,job_number")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const cacheKeyInput = `${projectId}|${maxUpdatedAt}|${itemCount ?? 0}||${""}|${project.job_number ?? ""}|cats:${uniqueSelectedCategories.sort().join(",")}|docs:0|`;
  const contentHash = createHash("sha256").update(cacheKeyInput).digest("hex").slice(0, 32);
  const cachePath = `${PDF_CACHE_PREFIX}/${projectId}/${contentHash}.pdf`;
  const filename = `${project.name.replace(/[^a-z0-9]+/gi, "-")}-FFE-Schedule.pdf`;

  const { data: cachedBlob } = await supabase.storage.from(ASSET_BUCKET).download(cachePath);
  if (cachedBlob) {
    const cachedBytes = new Uint8Array(await cachedBlob.arrayBuffer());
    return new NextResponse(cachedBytes, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Cache-Control": "no-store",
        "X-Pdf-Cache": "hit",
      },
    });
  }

  let itemsQuery = supabase
    .from("items")
    .select(PDF_ITEM_FIELDS)
    .eq("project_id", projectId)
    .is("deleted_at", null);
  if (hasCategories) itemsQuery = itemsQuery.in("category", uniqueSelectedCategories);

  const [{ data: items }, { data: categories }] = await Promise.all([
    itemsQuery.order("category", { ascending: true }).order("item_code", { ascending: true }),
    supabase.from("categories").select("*").order("sort_order"),
  ]);

  const typedItems = (items ?? []) as unknown as Item[];

  const resolvedImages = await ensureStoredImagesForItems(
    supabase,
    typedItems.map((it) => ({ id: it.id, selected_image_url: it.selected_image_url }))
  );

  const itemIds = typedItems.map((it) => it.id);
  const docsByItemId = new Set<string>();
  if (itemIds.length > 0) {
    const { data: fileRows } = await supabase.from("item_files").select("item_id").in("item_id", itemIds);
    for (const row of fileRows ?? []) {
      docsByItemId.add((row as { item_id: string }).item_id);
    }
  }

  const pdfItems = typedItems.map((it) => ({
    ...it,
    resolvedImageUrl: resolvedImages.get(it.id),
    hasDocs: docsByItemId.has(it.id),
  }));

  const generatedAt = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

  let buffer: Buffer;
  try {
    buffer = await renderToBuffer(
      SchedulePdf({
        project,
        items: pdfItems,
        categories: (categories ?? []) as Category[],
        generatedAt,
      })
    );
  } catch (err) {
    console.error("trade documents/schedule: render failed", err);
    return NextResponse.json({ error: "Could not generate the schedule. Please try again." }, { status: 500 });
  }

  const bytes = new Uint8Array(buffer);

  // Best-effort cache write — deferred via after() so it isn't killed
  // the instant the response is sent, same reasoning as the
  // team-facing PDF route's own identical after() call. A write
  // failure never fails the trade's response.
  after(() =>
    supabase.storage
      .from(ASSET_BUCKET)
      .upload(cachePath, bytes, { contentType: "application/pdf", upsert: true })
      .then(
        () => {},
        () => {}
      )
  );

  return new NextResponse(bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
      "X-Pdf-Cache": "miss",
    },
  });
}
