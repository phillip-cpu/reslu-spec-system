import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { ensureStoredImagesForItems } from "@/lib/images";
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
 */
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

  const [{ data: project }, { data: items }, { data: categories }] =
    await Promise.all([
      supabase
        .from("projects")
        .select("id,name,client_name,address")
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

  // Service-role client for the image pre-pass and item_files lookup —
  // Storage writes and cross-item existence checks are simplest against
  // RLS-bypassing server code here, same trust boundary as the portal
  // routes (server-only, never exposed to the browser).
  const serviceClient = createServiceRoleClient();

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

  const buffer = await renderToBuffer(
    SchedulePdf({
      project,
      items: pdfItems,
      categories: (categories ?? []) as Category[],
      generatedAt,
      revisionLabel,
      scheduleSubtitle,
    })
  );

  const filename = `${project.name.replace(/[^a-z0-9]+/gi, "-")}-FFE-Schedule.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
