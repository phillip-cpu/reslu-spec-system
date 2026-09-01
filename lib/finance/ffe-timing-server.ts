import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveExportPresets } from "../export-presets.ts";
import {
  deriveOrderBy,
  type OrderByContactInput,
  type OrderByItemInput,
  type WorksDateSource,
} from "../order-by.ts";
import {
  buildFfeForecastTimings,
  type FfeForecastTiming,
} from "./ffe-timing.ts";

export interface ProjectFfeForecastTiming {
  itemCategories: Record<string, string>;
  timings: Record<string, FfeForecastTiming>;
  directItemCount: number;
  datedItemCount: number;
}

/** Loads the same category→trade→booking timing used by Procurement. */
export async function loadProjectFfeForecastTiming(
  supabase: SupabaseClient,
  projectIds: string[],
  now = new Date()
): Promise<ProjectFfeForecastTiming> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (ids.length === 0) {
    return {
      itemCategories: {},
      timings: {},
      directItemCount: 0,
      datedItemCount: 0,
    };
  }

  const [itemsResult, visitsResult, tasksResult, presetResult] = await Promise.all([
    supabase
      .from("items")
      .select("id,project_id,category,lead_time_weeks,ordered_at,cost_scope")
      .in("project_id", ids)
      .is("deleted_at", null),
    supabase
      .from("trade_visits")
      .select("id,project_id,contact_id,start_date,status")
      .in("project_id", ids)
      .is("deleted_at", null)
      .neq("status", "declined"),
    supabase
      .from("board_tasks")
      .select("id,project_id,contact_id,booking_date")
      .in("project_id", ids)
      .is("deleted_at", null)
      .not("booking_date", "is", null),
    supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
  ]);
  const readError =
    itemsResult.error ?? visitsResult.error ?? tasksResult.error ?? presetResult.error;
  if (readError) throw new Error(readError.message);

  const items = (itemsResult.data ?? []) as OrderByItemInput[];
  const sources: WorksDateSource[] = [
    ...((visitsResult.data ?? []) as Array<{
      id: string;
      project_id: string;
      contact_id: string | null;
      start_date: string;
    }>).map((visit) => ({
      source_id: visit.id,
      source_kind: "visit" as const,
      project_id: visit.project_id,
      contact_id: visit.contact_id,
      start_date: visit.start_date,
    })),
    ...((tasksResult.data ?? []) as Array<{
      id: string;
      project_id: string;
      contact_id: string | null;
      booking_date: string | null;
    }>).filter((task) => task.booking_date).map((task) => ({
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
  const contactsResult = contactIds.length > 0
    ? await supabase
        .from("contacts")
        .select("id,category")
        .in("id", contactIds)
        .is("deleted_at", null)
    : { data: [] as OrderByContactInput[], error: null };
  if (contactsResult.error) throw new Error(contactsResult.error.message);

  const presets = resolveExportPresets(presetResult.data?.value);
  const contacts = (contactsResult.data ?? []) as OrderByContactInput[];
  // Project grouping keeps the company cockpit bounded: deriveOrderBy's
  // per-item source scan never walks bookings belonging to every other job.
  const orderBy = ids.flatMap((projectId) => deriveOrderBy(
    items.filter((item) => item.project_id === projectId),
    presets,
    contacts,
    sources.filter((source) => source.project_id === projectId),
    now
  ));
  const timings = buildFfeForecastTimings(items, orderBy);
  const directItems = items.filter((item) => item.cost_scope !== "trade_package");

  return {
    // Reference-only trade-package items have no standalone estimate plan.
    // Leaving them out makes any unexpected invoice an explicit unmatched
    // actual instead of reducing another direct item's category allowance.
    itemCategories: Object.fromEntries(
      directItems.map((item) => [item.id, item.category || "Uncategorised"])
    ),
    timings,
    directItemCount: directItems.length,
    datedItemCount: directItems.filter((item) => timings[item.id]?.plannedDate).length,
  };
}
