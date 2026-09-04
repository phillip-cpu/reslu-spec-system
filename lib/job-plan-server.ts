import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildJobPlan } from "@/lib/job-plan";
import { lineCost } from "@/lib/estimate";
import { derivedQuantity } from "@/lib/item-quantity";
import { loadItemScheduleRequirementData } from "@/lib/item-schedule-requirements-server";
import { supplierQuoteSummaryStatus } from "@/lib/supplier-quotes";
import type {
  JobPlanActivityInput,
  JobPlanCostLineInput,
  JobPlanItemInput,
  JobPlanPageData,
  JobPlanQuotePackageInput,
  JobPlanScopeLineInput,
  JobPlanTradeAssignmentInput,
} from "@/types/job-plan";
import type { SupplierQuoteRequestStatus } from "@/types/supplier-quotes";

type ProjectRow = JobPlanPageData["project"];
type SowRow = {
  id: string;
  revision_label: string;
  status: "draft" | "issued";
};
type SowSectionRow = {
  id: string;
  heading: string;
  sort: number;
  sow_lines: {
    id: string;
    section_id: string;
    text: string;
    kind: "inclusion" | "exclusion" | "note";
    sort: number;
    trade: string | null;
  }[] | null;
};
type TaskRow = {
  id: string;
  title: string;
  trade_role: string | null;
  phase_group_id: string | null;
  column_id: string;
  contact_id: string | null;
  booking_date: string | null;
  booking_end_date: string | null;
  due_date: string | null;
  sow_revision_id: string | null;
};
type GroupRow = { id: string; name: string; sort: number; phase_id: string | null };
type PhaseRow = { id: string; name: string; sort: number };
type ContactRow = { id: string; company: string };
type AssignmentRow = { trade_role: string; contact_id: string | null };
type CostSectionRow = {
  id: string;
  name: string;
  cost_lines: Array<{
    id: string;
    section_id: string;
    description: string;
    item_id: string | null;
    contact_id: string | null;
    qty: number | null;
    unit: string | null;
    rate_ex_gst: number | null;
    cost_ex_gst: number | null;
    quoted_to_client_ex_gst: number | null;
    actual_paid_ex_gst: number | null;
    quote_status: string | null;
    measurement_id: string | null;
    wastage_pct: number | null;
    deleted_at: string | null;
  }> | null;
};
type QuotePackageRow = { id: string; title: string };
type QuoteRequestRow = {
  package_id: string;
  status: SupplierQuoteRequestStatus;
  promised_quote_at: string | null;
  contact_id: string | null;
};

function assertNoError(error: { message: string } | null, context: string): void {
  if (error) throw new Error(`${context}: ${error.message}`);
}

/**
 * Loads one conservative connected read model. Exact database links and exact
 * item-code references are included; unlinked records stay unlinked so the UI
 * can make the gap visible rather than silently double-counting it.
 */
export async function loadJobPlanPageData(
  supabase: SupabaseClient,
  projectId: string,
  isAdmin: boolean
): Promise<JobPlanPageData | null> {
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,name,client_name,client_token")
    .eq("id", projectId)
    .maybeSingle();
  assertNoError(projectError, "Could not load project");
  if (!project) return null;

  const { data: latestSow, error: sowError } = await supabase
    .from("sow_documents")
    .select("id,revision_label,status")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  assertNoError(sowError, "Could not load current scope");

  const itemSelect = isAdmin
    ? "id,item_code,name,category,location,quantity,unit,cost_scope,status,price_trade,lead_time_weeks,ordered_at,eta,measurement_id,wastage_pct,coverage_per_unit"
    : "id,item_code,name,category,location,quantity,unit,cost_scope,status,lead_time_weeks,ordered_at,eta";

  const [sectionsResult, itemsResult, tasksResult, groupsResult, columnsResult, assignmentsResult] =
    await Promise.all([
      latestSow
        ? supabase
            .from("sow_sections")
            .select("id,heading,sort,sow_lines(id,section_id,text,kind,sort,trade)")
            .eq("sow_id", latestSow.id)
            .order("sort", { ascending: true })
        : Promise.resolve({ data: [] as SowSectionRow[], error: null }),
      supabase
        .from("items")
        .select(itemSelect)
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("item_code", { ascending: true }),
      supabase
        .from("board_tasks")
        .select("id,title,trade_role,phase_group_id,column_id,contact_id,booking_date,booking_end_date,due_date,sow_revision_id")
        .eq("project_id", projectId)
        .is("deleted_at", null),
      supabase
        .from("board_groups")
        .select("id,name,sort,phase_id")
        .eq("project_id", projectId)
        .order("sort", { ascending: true }),
      supabase
        .from("board_columns")
        .select("id,name")
        .eq("project_id", projectId),
      supabase
        .from("project_trade_assignments")
        .select("trade_role,contact_id")
        .eq("project_id", projectId),
    ]);

  assertNoError(sectionsResult.error, "Could not load scope clauses");
  assertNoError(itemsResult.error, "Could not load FF&E");
  assertNoError(tasksResult.error, "Could not load work activities");
  assertNoError(groupsResult.error, "Could not load work phases");
  assertNoError(columnsResult.error, "Could not load activity statuses");
  assertNoError(assignmentsResult.error, "Could not load trade assignments");

  const sections = (sectionsResult.data ?? []) as unknown as SowSectionRow[];
  const taskRows = (tasksResult.data ?? []) as unknown as TaskRow[];
  const groupRows = (groupsResult.data ?? []) as unknown as GroupRow[];
  const assignmentRows = (assignmentsResult.data ?? []) as unknown as AssignmentRow[];
  const phaseIds = [...new Set(groupRows.map((group) => group.phase_id).filter(Boolean))] as string[];
  const contactIds = [
    ...new Set(
      [...taskRows.map((task) => task.contact_id), ...assignmentRows.map((assignment) => assignment.contact_id)].filter(Boolean)
    ),
  ] as string[];
  const taskIds = taskRows.map((task) => task.id);

  const [phasesResult, contactsResult, scopeLinksResult, requirementsResult, costsResult, packagesResult, measurementsResult] =
    await Promise.all([
      phaseIds.length
        ? supabase.from("schedule_phases").select("id,name,sort").in("id", phaseIds).is("deleted_at", null)
        : Promise.resolve({ data: [] as PhaseRow[], error: null }),
      contactIds.length
        ? supabase.from("contacts").select("id,company").in("id", contactIds).is("deleted_at", null)
        : Promise.resolve({ data: [] as ContactRow[], error: null }),
      taskIds.length
        ? supabase.from("board_task_sow_lines").select("task_id,sow_line_id").in("task_id", taskIds)
        : Promise.resolve({ data: [] as { task_id: string; sow_line_id: string }[], error: null }),
      loadItemScheduleRequirementData(supabase, [projectId]),
      isAdmin
        ? supabase
            .from("cost_sections")
            .select("id,name,cost_lines(id,section_id,description,item_id,contact_id,qty,unit,rate_ex_gst,cost_ex_gst,quoted_to_client_ex_gst,actual_paid_ex_gst,quote_status,measurement_id,wastage_pct,deleted_at)")
            .eq("project_id", projectId)
            .order("sort", { ascending: true })
        : Promise.resolve({ data: [] as CostSectionRow[], error: null }),
      isAdmin
        ? supabase
            .from("supplier_quote_packages")
            .select("id,title")
            .eq("project_id", projectId)
            .is("deleted_at", null)
        : Promise.resolve({ data: [] as QuotePackageRow[], error: null }),
      isAdmin
        ? supabase.from("measurements").select("id,value").eq("project_id", projectId)
        : Promise.resolve({ data: [] as { id: string; value: number }[], error: null }),
    ]);

  assertNoError(phasesResult.error, "Could not load programme phases");
  assertNoError(contactsResult.error, "Could not load contractors");
  assertNoError(scopeLinksResult.error, "Could not load scope links");
  assertNoError(costsResult.error, "Could not load Estimate links");
  assertNoError(packagesResult.error, "Could not load quote packages");
  assertNoError(measurementsResult.error, "Could not load measured quantities");

  const phases = (phasesResult.data ?? []) as unknown as PhaseRow[];
  const contactById = new Map(
    ((contactsResult.data ?? []) as ContactRow[]).map((contact) => [contact.id, contact.company])
  );
  const groupById = new Map(groupRows.map((group) => [group.id, group]));
  const phaseById = new Map(phases.map((phase) => [phase.id, phase]));
  const statusByColumnId = new Map(
    ((columnsResult.data ?? []) as { id: string; name: string }[]).map((column) => [column.id, column.name])
  );
  const measurementById = new Map(
    ((measurementsResult.data ?? []) as { id: string; value: number }[]).map((measurement) => [measurement.id, measurement])
  );

  const scopeLines: JobPlanScopeLineInput[] = sections.flatMap((section) =>
    [...(section.sow_lines ?? [])]
      .sort((a, b) => a.sort - b.sort)
      .map((line) => ({
        id: line.id,
        section_id: section.id,
        room: section.heading,
        text: line.text,
        kind: line.kind,
        trade: line.trade,
      }))
  );
  const items: JobPlanItemInput[] = (itemsResult.data ?? []).map((item) => {
    const row = item as unknown as Omit<JobPlanItemInput, "price_trade"> & {
      price_trade?: number | null;
      measurement_id?: string | null;
      wastage_pct?: number | null;
      coverage_per_unit?: number | null;
    };
    const quantity = isAdmin
      ? derivedQuantity(
          {
            quantity: row.quantity,
            measurement_id: row.measurement_id ?? null,
            wastage_pct: row.wastage_pct ?? null,
            coverage_per_unit: row.coverage_per_unit ?? null,
          },
          row.measurement_id ? measurementById.get(row.measurement_id) : null
        ).quantity
      : row.quantity;
    return { ...row, quantity, price_trade: isAdmin ? row.price_trade ?? null : null };
  });
  const activities: JobPlanActivityInput[] = taskRows.map((task) => {
    const group = task.phase_group_id ? groupById.get(task.phase_group_id) : null;
    const phase = group?.phase_id ? phaseById.get(group.phase_id) : null;
    return {
      id: task.id,
      title: task.title,
      trade_role: task.trade_role,
      phase_name: phase?.name ?? group?.name ?? null,
      phase_sort: phase?.sort ?? group?.sort ?? null,
      status: statusByColumnId.get(task.column_id) ?? null,
      booking_date: task.booking_date,
      booking_end_date: task.booking_end_date,
      due_date: task.due_date,
      contact_id: task.contact_id,
      contractor_company: task.contact_id ? contactById.get(task.contact_id) ?? null : null,
      sow_revision_id: task.sow_revision_id,
    };
  });
  const tradeAssignments: JobPlanTradeAssignmentInput[] = assignmentRows.map((assignment) => ({
    trade_role: assignment.trade_role,
    contact_id: assignment.contact_id,
    contractor_company: assignment.contact_id ? contactById.get(assignment.contact_id) ?? null : null,
  }));
  const costLines: JobPlanCostLineInput[] = ((costsResult.data ?? []) as unknown as CostSectionRow[])
    .flatMap((section) =>
      (section.cost_lines ?? [])
        .filter((line) => !line.deleted_at)
        .map((cost) => ({
          id: cost.id,
          section_id: section.id,
          section_name: section.name,
          description: cost.description,
          item_id: cost.item_id,
          contact_id: cost.contact_id,
          qty: cost.qty,
          unit: cost.unit,
          rate_ex_gst: cost.rate_ex_gst,
          cost_ex_gst: lineCost(
            cost,
            cost.measurement_id ? measurementById.get(cost.measurement_id) : null
          ),
          quoted_to_client_ex_gst: cost.quoted_to_client_ex_gst,
          actual_paid_ex_gst: cost.actual_paid_ex_gst,
          quote_status: cost.quote_status,
        }))
    );

  const packageRows = (packagesResult.data ?? []) as unknown as QuotePackageRow[];
  const packageIds = packageRows.map((pack) => pack.id);
  let quotePackages: JobPlanQuotePackageInput[] = [];
  if (isAdmin && packageIds.length > 0) {
    const [quoteLinesResult, quoteItemsResult, quoteRequestsResult] = await Promise.all([
      supabase.from("supplier_quote_package_lines").select("package_id,cost_line_id").in("package_id", packageIds),
      supabase.from("supplier_quote_package_items").select("package_id,item_id").in("package_id", packageIds),
      supabase.from("supplier_quote_requests").select("package_id,status,promised_quote_at,contact_id").in("package_id", packageIds),
    ]);
    assertNoError(quoteLinesResult.error, "Could not load quote Estimate links");
    assertNoError(quoteItemsResult.error, "Could not load quote FF&E links");
    assertNoError(quoteRequestsResult.error, "Could not load supplier responses");
    const requests = (quoteRequestsResult.data ?? []) as unknown as QuoteRequestRow[];
    const requestContactIds = [...new Set(requests.map((request) => request.contact_id).filter(Boolean))] as string[];
    const { data: requestContacts, error: requestContactsError } = requestContactIds.length
      ? await supabase.from("contacts").select("id,company").in("id", requestContactIds)
      : { data: [] as ContactRow[], error: null };
    assertNoError(requestContactsError, "Could not load quote suppliers");
    const supplierById = new Map((requestContacts ?? []).map((contact) => [contact.id, contact.company]));

    quotePackages = packageRows.map((pack) => {
      const packRequests = requests.filter((request) => request.package_id === pack.id);
      const selected = packRequests.find((request) => request.status === "selected");
      const dueDates = packRequests
        .filter((request) => ["sent", "acknowledged"].includes(request.status))
        .map((request) => request.promised_quote_at)
        .filter((date): date is string => !!date)
        .sort();
      return {
        id: pack.id,
        title: pack.title,
        status: supplierQuoteSummaryStatus(packRequests.map((request) => request.status)),
        line_ids: (quoteLinesResult.data ?? [])
          .filter((link) => link.package_id === pack.id)
          .map((link) => link.cost_line_id),
        item_ids: (quoteItemsResult.data ?? [])
          .filter((link) => link.package_id === pack.id)
          .map((link) => link.item_id),
        supplier_names: [
          ...new Set(
            packRequests
              .map((request) => (request.contact_id ? supplierById.get(request.contact_id) : null))
              .filter((name): name is string => !!name)
          ),
        ],
        selected_supplier_name: selected?.contact_id
          ? supplierById.get(selected.contact_id) ?? null
          : null,
        next_due: dueDates[0] ?? null,
      };
    });
  }

  return {
    project: project as ProjectRow,
    is_admin: isAdmin,
    model: buildJobPlan({
      sow_id: (latestSow as SowRow | null)?.id ?? null,
      sow_revision_label: (latestSow as SowRow | null)?.revision_label ?? null,
      sow_status: (latestSow as SowRow | null)?.status ?? null,
      scope_lines: scopeLines,
      items,
      activities,
      phases: groupRows.map((group) => {
        const phase = group.phase_id ? phaseById.get(group.phase_id) : null;
        return {
          id: group.id,
          name: phase?.name ?? group.name,
          sort: phase?.sort ?? group.sort,
        };
      }),
      activity_scope_links: (scopeLinksResult.data ?? []) as { task_id: string; sow_line_id: string }[],
      item_requirements: requirementsResult.requirements.map((requirement) => ({
        item_id: requirement.item_id,
        board_task_id: requirement.board_task_id,
        buffer_days: requirement.buffer_days,
        required_on_site_date: requirement.activity?.required_on_site_date ?? null,
      })),
      cost_lines: costLines,
      quote_packages: quotePackages,
      trade_assignments: tradeAssignments,
      include_financials: isAdmin,
    }),
  };
}
