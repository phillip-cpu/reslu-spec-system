import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveExportPresets } from "@/lib/export-presets";
import {
  deriveOrderBy,
  type OrderByContactInput,
  type OrderByItemInput,
  type WorksDateSource,
} from "@/lib/order-by";
import { deriveProjectDataQuality } from "@/lib/project-data-quality";
import type {
  DataQualityColumnInput,
  DataQualityItemInput,
  DataQualityTaskInput,
  DataQualityVisitInput,
  ProjectDataQualityResponse,
} from "@/types/data-quality";

export function adelaideDateKey(now = new Date()): string {
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
 * Load the bounded project inputs used by the pure data-quality engine.
 * Keeping this in one server-only module means the Project Health panel,
 * Aria's company-wide feed and the automated action sync cannot drift into
 * three different definitions of the same risk.
 */
export async function loadProjectDataQuality(
  supabase: SupabaseClient,
  projectId: string,
  now = new Date()
): Promise<ProjectDataQualityResponse> {
  const [itemsResult, columnsResult, tasksResult, visitsResult, presetResult] =
    await Promise.all([
      supabase
        .from("items")
        .select(
          "id,item_code,category,name,quantity,status,supplier,supplier_contact_id,price_trade,price_rrp,lead_time_weeks,ordered_at,delivered_at"
        )
        .eq("project_id", projectId)
        .is("deleted_at", null),
      supabase.from("board_columns").select("id,name").eq("project_id", projectId),
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
      supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
    ]);

  const queryError =
    itemsResult.error ??
    columnsResult.error ??
    tasksResult.error ??
    visitsResult.error ??
    presetResult.error;
  if (queryError) throw new Error(queryError.message);

  const items = (itemsResult.data ?? []) as DataQualityItemInput[];
  const itemIds = items.map((item) => item.id);
  const { data: roomRows, error: roomsError } = itemIds.length
    ? await supabase.from("item_rooms").select("item_id").in("item_id", itemIds)
    : { data: [] as { item_id: string }[], error: null };
  if (roomsError) throw new Error(roomsError.message);

  const taskRows = (tasksResult.data ?? []) as Array<
    DataQualityTaskInput & { project_id: string; contact_id: string | null }
  >;
  const visitRows = (visitsResult.data ?? []) as Array<
    DataQualityVisitInput & { project_id: string; contact_id: string | null }
  >;

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
  if (contactsError) throw new Error(contactsError.message);

  const today = adelaideDateKey(now);
  const orderItems: OrderByItemInput[] = items.map((item) => ({
    id: item.id,
    project_id: projectId,
    category: item.category,
    lead_time_weeks: item.lead_time_weeks,
    ordered_at: item.ordered_at,
  }));
  const presets = resolveExportPresets(presetResult.data?.value);
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

  return deriveProjectDataQuality({
    project_id: projectId,
    items,
    room_item_ids: (roomRows ?? []).map((row) => row.item_id),
    columns: (columnsResult.data ?? []) as DataQualityColumnInput[],
    tasks: taskRows,
    visits: visitRows,
    order_by: orderBy,
    today,
  });
}
