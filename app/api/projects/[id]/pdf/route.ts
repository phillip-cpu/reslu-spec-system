import { createHash } from "node:crypto";
import { NextRequest, NextResponse, after } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { ensureStoredImagesForItems } from "@/lib/images";
import { ASSET_BUCKET } from "@/lib/storage";
import { reportError } from "@/lib/report-error";
import { SchedulePdf } from "@/components/pdf/SchedulePdf";
import { parseCategoriesParam } from "@/lib/export-presets";
import { buildDocBundle, type BundleItemDoc } from "@/lib/pdf-bundle";
import type { Category, Item, ItemFile } from "@/types";

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
 *
 * "Export + board batch" round (7 July 2026) additions:
 *
 * - `?categories=TW,SW` — multi-category filter (BUILD-SPEC.md item 1:
 *   "extend the route's filter to multi; keep single-category back-
 *   compat"). The legacy singular `?category=TW` continues to work
 *   unchanged — both params are merged (see parseCategoriesParam
 *   calls below); absent/empty means "no filter — every category",
 *   matching the export dialog's "all ticked default = full schedule"
 *   behaviour. Selected categories are folded into BOTH the item query
 *   (a Postgres `.in("category", ...)` filter) and the cache key, so
 *   two different category sets for the same project never collide on
 *   one cached object.
 * - `?docs=1` — "Include item documents" (item 3): when set, the
 *   response is the merged print bundle (schedule + each in-scope
 *   item's attached spec_sheet/install_manual PDFs, via
 *   lib/pdf-bundle.ts) instead of the bare schedule. Folded into the
 *   cache key too (a docs=1 request must never serve a cached bare-
 *   schedule object from a prior docs-less request at the same
 *   category set, and vice versa) along with a digest of the in-scope
 *   items' item_files rows (kind/storage_path/uploaded_at) — item_files
 *   has no updated_at column (files are uploaded/deleted, never edited
 *   in place), so uploaded_at + row identity is the correct "has this
 *   item's file set changed" proxy, same reasoning as the existing
 *   items.updated_at-based key above.
 * - `?filename=` — optional override for the filename hint shown in
 *   the export dialog ("{project} — {preset|Custom} schedule"); when
 *   absent, falls back to the existing "{Project}-FFE-Schedule.pdf"
 *   generated name.
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
  const filenameHint = searchParams.get("filename") ?? undefined;

  // Multi-category filter (BUILD-SPEC.md "Export + board batch" item
  // 1) — `?categories=TW,SW` is the new param; the legacy singular
  // `?category=TW` still works (merged in below) for back-compat with
  // any existing bookmarked/scripted link. Empty/absent means "every
  // category" (the export dialog's "all ticked default = full
  // schedule").
  const selectedCategories = [
    ...parseCategoriesParam(searchParams.get("categories")),
    ...parseCategoriesParam(searchParams.get("category")),
  ];
  const uniqueSelectedCategories = [...new Set(selectedCategories)];
  const hasCategories = uniqueSelectedCategories.length > 0;

  // "Include item documents" (item 3) — when set, the response is the
  // merged print bundle rather than the bare schedule.
  const includeDocs = searchParams.get("docs") === "1";

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
  // too. The category filter (if any) is applied to this same key
  // query so a "TW,SW only" cache entry and a "full schedule" cache
  // entry for the same project never collide.
  let keyQuery = supabase
    .from("items")
    .select("updated_at")
    .eq("project_id", id)
    .is("deleted_at", null);
  if (hasCategories) keyQuery = keyQuery.in("category", uniqueSelectedCategories);
  const { data: keyRows } = await keyQuery.order("updated_at", { ascending: false }).limit(1);
  const maxUpdatedAt = keyRows?.[0]?.updated_at ?? "epoch";

  let countQuery = supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .eq("project_id", id)
    .is("deleted_at", null);
  if (hasCategories) countQuery = countQuery.in("category", uniqueSelectedCategories);
  const { count: itemCount } = await countQuery;

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

  // Print bundle cache-key input (item 3): a digest of the in-scope
  // items' item_files rows, so attaching/removing a spec sheet on any
  // in-scope item invalidates the bundle cache. Only computed when
  // includeDocs is set — a bare schedule request never touches
  // item_files at all, same as before this round. item_files carries
  // no updated_at column (see this file's header comment above) —
  // uploaded_at + kind + storage_path per row is the correct "has the
  // file set changed" proxy for a table whose rows are only ever
  // inserted/deleted, never edited in place.
  let docsDigest = "";
  if (includeDocs) {
    let scopedItemIdsQuery = supabase
      .from("items")
      .select("id")
      .eq("project_id", id)
      .is("deleted_at", null);
    if (hasCategories) scopedItemIdsQuery = scopedItemIdsQuery.in("category", uniqueSelectedCategories);
    const { data: scopedItemIds } = await scopedItemIdsQuery;
    const ids = (scopedItemIds ?? []).map((r) => (r as { id: string }).id);
    if (ids.length > 0) {
      const { data: fileKeyRows } = await serviceClient
        .from("item_files")
        .select("item_id,kind,storage_path,uploaded_at")
        .in("item_id", ids)
        .order("item_id", { ascending: true })
        .order("uploaded_at", { ascending: true });
      docsDigest = (fileKeyRows ?? [])
        .map((r) => {
          const row = r as { item_id: string; kind: string; storage_path: string; uploaded_at: string };
          return `${row.item_id}:${row.kind}:${row.storage_path}:${row.uploaded_at}`;
        })
        .join("|");
    }
  }

  const cacheKeyInput = `${id}|${maxUpdatedAt}|${itemCount ?? 0}|${revisionLabel ?? ""}|${scheduleSubtitle ?? ""}|${keyProject?.job_number ?? ""}|cats:${uniqueSelectedCategories.sort().join(",")}|docs:${includeDocs ? "1" : "0"}|${docsDigest}`;
  const contentHash = createHash("sha256").update(cacheKeyInput).digest("hex").slice(0, 32);
  const cachePath = `${PDF_CACHE_PREFIX}/${id}/${contentHash}.pdf`;

  const suffix = includeDocs ? "FFE-Print-Bundle" : "FFE-Schedule";

  if (!noCache) {
    const { data: cachedBlob } = await serviceClient.storage.from(ASSET_BUCKET).download(cachePath);
    if (cachedBlob) {
      const cachedBytes = new Uint8Array(await cachedBlob.arrayBuffer());
      const { data: projectForFilename } = await supabase
        .from("projects")
        .select("name")
        .eq("id", id)
        .single();
      const cachedFilename =
        filenameHint ?? `${(projectForFilename?.name ?? "Project").replace(/[^a-z0-9]+/gi, "-")}-${suffix}.pdf`;
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

  let itemsQuery = supabase
    .from("items")
    .select(PDF_ITEM_FIELDS)
    .eq("project_id", id)
    .is("deleted_at", null);
  if (hasCategories) itemsQuery = itemsQuery.in("category", uniqueSelectedCategories);

  const [{ data: project }, { data: items }, { data: categories }] =
    await Promise.all([
      supabase
        // job_number added (migration 028_job_numbers.sql) for the
        // cover + footer "Project No." line — see SchedulePdf.tsx.
        .from("projects")
        .select("id,name,client_name,address,job_number")
        .eq("id", id)
        .single(),
      itemsQuery.order("category", { ascending: true }).order("item_code", { ascending: true }),
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

  let bytes = new Uint8Array(buffer);

  // ---- Print bundle (item 3): merge in each in-scope item's attached
  // documents when requested. Sequential fetches inside buildDocBundle
  // — see that module's own doc comment for the function-timeout
  // caveat this round documents (README.md "PDF bundle size").
  // Failures are handled entirely inside buildDocBundle (per-file
  // skip + index-page note) — this route only needs to catch a
  // catastrophic failure of the merge step itself and fall back to
  // serving the bare schedule rather than erroring the whole request,
  // since the team member still gets a usable PDF either way.
  if (includeDocs) {
    try {
      let docItemsQuery = serviceClient
        .from("items")
        .select("id,item_code,name,category")
        .eq("project_id", id)
        .is("deleted_at", null);
      if (hasCategories) docItemsQuery = docItemsQuery.in("category", uniqueSelectedCategories);
      const { data: docItems } = await docItemsQuery
        .order("category", { ascending: true })
        .order("item_code", { ascending: true });
      const scopedItems = (docItems ?? []) as { id: string; item_code: string | null; name: string }[];
      const scopedItemIds = scopedItems.map((it) => it.id);

      const filesByItemId = new Map<string, ItemFile[]>();
      if (scopedItemIds.length > 0) {
        const { data: fileRows } = await serviceClient
          .from("item_files")
          .select("*")
          .in("item_id", scopedItemIds)
          .in("kind", ["spec_sheet", "install_manual"])
          .order("uploaded_at", { ascending: true });
        for (const row of (fileRows ?? []) as ItemFile[]) {
          const list = filesByItemId.get(row.item_id) ?? [];
          list.push(row);
          filesByItemId.set(row.item_id, list);
        }
      }

      const bundleDocs: BundleItemDoc[] = scopedItems
        .filter((it) => (filesByItemId.get(it.id)?.length ?? 0) > 0)
        .map((it) => ({
          itemId: it.id,
          itemCode: it.item_code,
          itemName: it.name,
          files: filesByItemId.get(it.id) ?? [],
        }));

      const bundled = await buildDocBundle(serviceClient, bytes, bundleDocs);
      // buildDocBundle()'s declared Uint8Array return type resolves to
      // the wider Uint8Array<ArrayBufferLike> (SharedArrayBuffer or
      // ArrayBuffer), but pdf-lib's PDFDocument.save() only ever
      // produces a plain ArrayBuffer-backed array at runtime — narrowed
      // here to match `bytes`'s inferred Uint8Array<ArrayBuffer> type
      // (from the Buffer source above), which NextResponse's BodyInit
      // requires.
      bytes = bundled as Uint8Array<ArrayBuffer>;
    } catch (err) {
      await reportError("pdf-route-bundle", err);
      // Fall through and serve the bare schedule bytes already in
      // `bytes` — a degraded-but-usable response beats a hard failure.
    }
  }

  const filename = filenameHint ?? `${project.name.replace(/[^a-z0-9]+/gi, "-")}-${suffix}.pdf`;

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
