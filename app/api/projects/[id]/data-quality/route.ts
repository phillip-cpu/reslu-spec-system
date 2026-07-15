import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { FALLBACK_EXPORT_PRESETS } from "@/lib/export-presets";
import {
  deriveOrderBy,
  type OrderByContactInput,
  type OrderByItemInput,
  type WorksDateSource,
} from "@/lib/order-by";
import { deriveProjectDataQuality } from "@/lib/project-data-quality";
import { createClient } from "@/lib/supabase/server";
import type {
  DataQualityColumnInput,
  DataQualityItemInput,
  DataQualityTaskInput,
  DataQualityVisitInput,
} from "@/types/data-quality";
import type { ExportPresetRow } from "@/types/round-export-batch";

export const runtime = "nodejs";

function adelaideToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${value("year")}-${value("month")}-${value("day")}`;
}

/**
 * GET /api/projects/[id]/data-quality
 *
 * Admin-only, read-only project diagnostics. Pricing and procurement
 * columns never leave this route except as compact coverage totals and
 * actionable issue counts. Nothing here mutates a project, item,
 * booking or board task.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);

  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access project data quality" },
      { status: 403 }
    );
  }

  const [itemsResult, columnsResult, tasksResult, visitsResult, presetResult] =
    await Promise.all([
      supabase
        .from("items")
        .select(
          "id,item_code,category,name,quantity,status,supplier,supplier_contact_id,price_trade,price_rrp,lead_time_weeks,ordered_at,delivered_at"
        )
        .eq("project_id", projectId)
        .is("deleted_at", null),
      supabase
        .from("board_columns")
        .select("id,name")
        .eq("project_id", projectId),
      supabase
        .from("board_tasks")
        .select(
          "id,project_id,title,column_id,booking_date,booking_end_date,visit_id,contact_id"
        )
        .eq("project_id", projectId)
        .is("deleted_at", null),
      supabase
        .from("trade_visits")
        .select("id,project_id,status,start_date,end_date,contact_id")
        .eq("project_id", projectId)
        .is("deleted_at", null),
      supabase
        .from("app_settings")
        .select("value")
        .eq("key", "export_presets")
        .maybeSingle(),
    ]);

  const queryError =
    itemsResult.error ??
    columnsResult.error ??
    tasksResult.error ??
    visitsResult.error ??
    presetResult.error;
  if (queryError) {
    return NextResponse.json({ error: queryError.message }, { status: 500 });
  }

  const items = (itemsResult.data ?? []) as DataQualityItemInput[];
  const itemIds = items.map((item) => item.id);
  const { data: roomRows, error: roomsError } = itemIds.length
    ? await supabase.from("item_rooms").select("item_id").in("item_id", itemIds)
    : { data: [] as { item_id: string }[], error: null };
  if (roomsError) {
    return NextResponse.json({ error: roomsError.message }, { status: 500 });
  }

  const taskRows = (tasksResult.data ?? []) as Array<
    DataQualityTaskInput & {
      project_id: string;
      contact_id: string | null;
    }
  >;
  const visitRows = (visitsResult.data ?? []) as Array<
    DataQualityVisitInput & {
      project_id: string;
      contact_id: string | null;
    }
  >;

  // Reuse the exact order-by domain function used by Procurement and
  // My Work. This route only supplies the same bounded project inputs.
  const sources: WorksDateSource[] = [
    ...visitRows
      .filter((visit) => visit.status !== "declined")
      .map((visit) => ({
        source_id: visit.id,
        source_kind: "visit" as const,
        project_id: visit.project_id,
        contact_id: visit.contact_id,
        start_date: visit.start_date,
      })),
    ...taskRows
      .filter((task) => Boolean(task.booking_date))
      .map((task) => ({
        source_id: task.id,
        source_kind: "board_task_booking" as const,
        project_id: task.project_id,
        contact_id: task.contact_id,
        start_date: task.booking_date as string,
      })),
  ];

  const contactIds = [
    ...new Set(sources.map((source) => source.contact_id).filter(Boolean)),
  ] as string[];
  const { data: contactRows, error: contactsError } = contactIds.length
    ? await supabase
        .from("contacts")
        .select("id,category")
        .in("id", contactIds)
        .is("deleted_at", null)
    : { data: [] as OrderByContactInput[], error: null };
  if (contactsError) {
    return NextResponse.json({ error: contactsError.message }, { status: 500 });
  }

  const today = adelaideToday();
  const orderItems: OrderByItemInput[] = items.map((item) => ({
    id: item.id,
    project_id: projectId,
    category: item.category,
    lead_time_weeks: item.lead_time_weeks,
    ordered_at: item.ordered_at,
  }));
  const presets =
    (presetResult.data?.value as ExportPresetRow[] | undefined) ??
    FALLBACK_EXPORT_PRESETS;
  const orderBy = deriveOrderBy(
    orderItems,
    presets,
    (contactRows ?? []) as OrderByContactInput[],
    sources,
    new Date(`${today}T12:00:00Z`)
  ).map((row) => ({
    item_id: row.item_id,
    status: row.status,
    order_by: row.order_by,
    works_date: row.works_date,
  }));

  const report = deriveProjectDataQuality({
    project_id: projectId,
    items,
    room_item_ids: (roomRows ?? []).map((row) => row.item_id),
    columns: (columnsResult.data ?? []) as DataQualityColumnInput[],
    tasks: taskRows,
    visits: visitRows,
    order_by: orderBy,
    today,
  });

  return NextResponse.json(report);
}
