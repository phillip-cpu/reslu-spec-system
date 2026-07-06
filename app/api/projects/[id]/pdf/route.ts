import { createHash } from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { ensureStoredImagesForItems } from "@/lib/images";
import { ASSET_BUCKET } from "@/lib/storage";
import { reportError } from "@/lib/report-error";
import { SchedulePdf } from "@/components/pdf/SchedulePdf";
import type { Category, Item } from "@/types";

// react-pdf + font/logo file reads require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[id]/pdf
 * Renders the builder-facing FF&E schedule PDF (BUILD-SPEC.md §10).
 *
 * Carries NO pricing or ordering data — explicit column selection below
 * (PDF_ITEM_FIELDS) rather than `select("*")`, so a future column added
 * to `items` (e.g. a new pricing field) can never silently leak into the
 * PDF just because the query used `*`. Same spec-only field set as the
 * client portal.
 *
 * Phase 14A caching (BUILD-SPEC.md Phase 14 "PDF route: cache generated
 * PDF to storage keyed on a content hash of the item set (items
 * updated_at max + count), serve cached copy when unchanged; regenerate
 * otherwise"): react-pdf rendering + the sequential image pre-pass
 * (lib/images.ts) are the most expensive things this app does per
 * request — most PDF opens are a team member re-viewing/re-downloading
 * a schedule that hasn't changed since the last render. A cheap
 * "cache-key" query (max(updated_at), count(*) over the project's
 * active items) runs FIRST; if a Storage object already exists at that
 * key, its bytes are streamed back directly and the render/image-copy
 * work never happens at all. The key also folds in revisionLabel/
 * scheduleSubtitle (the two query-string inputs that change the
 * rendered output independent of the item set) so two different
 * ?revision= values for the same items never collide on one cached
 * object. Storage path lives under the private `assets` bucket
 * (pdf-cache/{projectId}/{hash}.pdf) — a plain object write/read, not a
 * signed-URL flow, since this route already streams the bytes itself.
 */
const PDF_CACHE_PREFIX = "pdf-cache";
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

export async function GET(
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

  const { searchParams } = new URL(request.url);
  const revisionLabel = searchParams.get("revision") ?? undefined;
  const scheduleSubtitle = searchParams.get("subtitle") ?? undefined;
  const noCache = searchParams.get("nocache") === "1";

  // Service-role client for the image pre-pass, item_files lookup, and
  // the PDF cache itself — Storage writes/reads and cross-item
  // existence checks are simplest against RLS-bypassing server code
  // here, same trust boundary as the portal routes (server-only, never
  // exposed to the browser).
  const serviceClient = createServiceRoleClient();

  // ---- Cache-key pre-check (cheap: one query, no image work, no
  // render) ----
  // BUILD-SPEC.md: "keyed on a content hash of the item set (items
  // updated_at max + count)". A project with zero items still gets a
  // valid, stable key (count 0, epoch max) so an empty schedule caches
  // too.
  const { data: keyRows } = await supabase
    .from("items")
    .select("updated_at")
    .eq("project_id", id)
    .is("deleted_at", null)
    .order("updated_at", { ascending: false })
    .limit(1);
  const maxUpdatedAt = keyRows?.[0]?.updated_at ?? "epoch";
  const { count: itemCount } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id)
    .is("deleted_at", null);

  // job_number (migration 028_job_numbers.sql) is rendered on the cover
  // + footer independent of the item set — folded into the cache key
  // (same reasoning as revisionLabel/scheduleSubtitle above it) so a
  // project renumbered in Settings never serves a stale cached PDF
  // showing the old number.
  const { data: keyProject } = await supabase
    .from("projects")
    .select("job_number")
    .eq("id", id)
    .single();

  const cacheKeyInput = `${id}|${maxUpdatedAt}|${itemCount ?? 0}|${revisionLabel ?? ""}|${scheduleSubtitle ?? ""}|${keyProject?.job_number ?? ""}`;
  const contentHash = createHash("sha256").update(cacheKeyInput).digest("hex").slice(0, 32);
  const cachePath = `${PDF_CACHE_PREFIX}/${id}/${contentHash}.pdf`;

  if (!noCache) {
    const { data: cachedBlob } = await serviceClient.storage.from(ASSET_BUCKET).download(cachePath);
    if (cachedBlob) {
      const cachedBytes = new Uint8Array(await cachedBlob.arrayBuffer());
      const { data: projectForFilename } = await supabase
        .from("projects")
        .select("name")
        .eq("id", id)
        .single();
      const cachedFilename = `${(projectForFilename?.name ?? "Project").replace(/[^a-z0-9]+/gi, "-")}-FFE-Schedule.pdf`;
      return new NextResponse(cachedBytes, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${cachedFilename}"`,
          "Cache-Control": "no-store",
          "X-Pdf-Cache": "hit",
        },
      });
    }
  }

  const [{ data: project }, { data: items }, { data: categories }] =
    await Promise.all([
      supabase
        // job_number added (migration 028_job_numbers.sql) for the
        // cover + footer "Project No." line — see SchedulePdf.tsx.
        .from("projects")
        .select("id,name,client_name,address,job_number")
        .eq("id", id)
        .single(),
      supabase
        .from("items")
        .select(PDF_ITEM_FIELDS)
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("category", { ascending: true })
        .order("item_code", { ascending: true }),
      supabase.from("categories").select("*").order("sort_order"),
    ]);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const typedItems = (items ?? []) as unknown as Item[];

  // Image pre-pass (BUILD-SPEC.md §6 / lib/images.ts): ensure every
  // item's image is served from our Storage, not a supplier site, before
  // rendering. Sequential with per-image try/catch inside
  // ensureStoredImagesForItems — one bad image is skipped, never fails
  // the whole PDF.
  const resolvedImages = await ensureStoredImagesForItems(
    serviceClient,
    typedItems.map((it) => ({
      id: it.id,
      selected_image_url: it.selected_image_url,
    }))
  );

  // item_files existence check — drives the deferred "Docs: spec sheet
  // available in portal" label (BUILD-SPEC.md §5/§10; QR codes deferred,
  // no new deps available for QR generation in this pass).
  const itemIds = typedItems.map((it) => it.id);
  const docsByItemId = new Set<string>();
  if (itemIds.length > 0) {
    const { data: fileRows } = await serviceClient
      .from("item_files")
      .select("item_id")
      .in("item_id", itemIds);
    for (const row of fileRows ?? []) {
      docsByItemId.add((row as { item_id: string }).item_id);
    }
  }

  const pdfItems = typedItems.map((it) => ({
    ...it,
    resolvedImageUrl: resolvedImages.get(it.id),
    hasDocs: docsByItemId.has(it.id),
  }));

  const generatedAt = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Phase 14A error visibility (BUILD-SPEC.md Phase 14 "uptime + error
  // monitoring") — react-pdf rendering is the single most likely
  // failure point in this route (a malformed font, an unexpected null
  // deep in a component prop, etc.); previously an uncaught throw here
  // fell through to Next.js's generic error page with nothing recorded
  // anywhere. Now it's logged to app_errors (see lib/report-error.ts,
  // admin Settings "System health") and returns a clean 500 instead.
  let buffer: Buffer;
  try {
    buffer = await renderToBuffer(
      SchedulePdf({
        project,
        items: pdfItems,
        categories: (categories ?? []) as Category[],
        generatedAt,
        revisionLabel,
        scheduleSubtitle,
      })
    );
  } catch (err) {
    await reportError("pdf-route", err);
    return NextResponse.json({ error: "Could not generate the PDF. Please try again." }, { status: 500 });
  }

  const filename = `${project.name.replace(/[^a-z0-9]+/gi, "-")}-FFE-Schedule.pdf`;
  const bytes = new Uint8Array(buffer);

  // Best-effort cache write, deferred via next/server's after() so it
  // isn't killed the instant the response is sent on serverless
  // runtimes (Vercel) — same reasoning as the fetch-first scrape's
  // after() call in app/api/projects/[id]/items/route.ts; a plain
  // fire-and-forget promise is not guaranteed to complete post-response
  // outside a long-lived server. upsert since a rare race (two team
  // members opening the PDF at the exact same moment on a cold cache)
  // would otherwise 409 on the second write; the content is identical
  // either way since it's keyed on the same hash. A write failure never
  // fails the PDF response — the team member still gets their PDF,
  // just without a cached copy for the next request.
  after(() =>
    serviceClient.storage
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
