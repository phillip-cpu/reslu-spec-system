import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { resolveExportPresets } from "@/lib/export-presets";
import { deriveOrderBy, missingLeadTimes, type OrderByContactInput, type OrderByItemInput, type WorksDateSource } from "@/lib/order-by";
import type { OrderingDueAttentionItem, ProjectAttentionResponse } from "@/types/order-by";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/attention
 * "Order-by engine — product deadlines from trade bookings" (Phillip,
 * 8 July 2026), BUILD-SPEC item 3: "project needs-attention group
 * 'ordering_due' (order_by within 7 days or past)" + the missing-lead-
 * times amendment ("a low-urgency attention line").
 *
 * ADDITIVE, NOT a rewrite of anything: this codebase's existing
 * needs-attention surfaces are each their own per-domain, cross-project
 * endpoint (GET /api/visits/attention -> proposed_pending/starting_soon,
 * GET /api/board-tasks/attention -> bookings_overdue, GET
 * /api/contacts/attention -> insurance groups, GET /api/leads/attention
 * -> the four lead groups, GET /api/materials/attention ->
 * price_refreshes_pending) — none of those routes or their response
 * shapes are touched here. This is a NEW, PROJECT-SCOPED route (there
 * was no existing single "project needs-attention feed" endpoint to
 * extend — see this round's own research notes) carrying exactly the
 * two groups this round's brief asks for: 'ordering_due' and
 * 'missing_lead_times'. A future round is free to fold every group
 * (this project's + the cross-project ones) into one combined feed;
 * doing so is explicitly out of this round's additive-only scope.
 *
 * Admin-only, server-enforced — mirrors GET /api/projects/[id]/order-by's
 * EXACT gating (this route reuses that same lib/order-by.ts derivation
 * over lead_time_weeks, which is P&P-only/procurement-sensitive data),
 * not the team-visible pattern the scheduling-only attention endpoints
 * above use.
 */
export async function GET(
  _request: NextRequest,
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
      { error: "Only admins can access the project attention feed" },
      { status: 403 }
    );
  }

  const [{ data: itemRows, error: itemsError }, { data: presetSetting }] = await Promise.all([
    supabase
      .from("items")
      .select("id,project_id,item_code,name,category,lead_time_weeks,ordered_at")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("ordered_at", null),
    supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
  ]);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  const itemRowsTyped = (itemRows ?? []) as (OrderByItemInput & { item_code: string; name: string })[];
  const presets = resolveExportPresets(presetSetting?.value);

  if (itemRowsTyped.length === 0) {
    const body: ProjectAttentionResponse = {
      ordering_due: [],
      missing_lead_times: { count: 0, href: `/projects/${projectId}?tab=ffe` },
    };
    return NextResponse.json(body);
  }

  const [{ data: visitRows }, { data: taskRows }] = await Promise.all([
    supabase
      .from("trade_visits")
      .select("id,project_id,contact_id,start_date,status")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .neq("status", "declined"),
    supabase
      .from("board_tasks")
      .select("id,project_id,contact_id,booking_date")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .not("booking_date", "is", null),
  ]);

  const sources: WorksDateSource[] = [
    ...((visitRows ?? []) as { id: string; project_id: string; contact_id: string | null; start_date: string }[]).map(
      (v) => ({
        source_id: v.id,
        source_kind: "visit" as const,
        project_id: v.project_id,
        contact_id: v.contact_id,
        start_date: v.start_date,
      })
    ),
    ...((taskRows ?? []) as { id: string; project_id: string; contact_id: string | null; booking_date: string | null }[])
      .filter((t) => t.booking_date)
      .map((t) => ({
        source_id: t.id,
        source_kind: "board_task_booking" as const,
        project_id: t.project_id,
        contact_id: t.contact_id,
        start_date: t.booking_date as string,
      })),
  ];

  const contactIds = [...new Set(sources.map((s) => s.contact_id).filter(Boolean))] as string[];
  const { data: contactRows } = contactIds.length
    ? await supabase.from("contacts").select("id,category").in("id", contactIds).is("deleted_at", null)
    : { data: [] as { id: string; category: string | null }[] };
  const contacts: OrderByContactInput[] = (contactRows ?? []).map((c) => ({ id: c.id, category: c.category }));

  const results = deriveOrderBy(itemRowsTyped, presets, contacts, sources);
  const missing = missingLeadTimes(itemRowsTyped);
  const itemById = new Map(itemRowsTyped.map((i) => [i.id, i]));

  // 'ordering_due': due_soon or overdue only, sorted overdue-first (per
  // BUILD-SPEC item 3), then by order_by date ascending within each
  // status bucket (most urgent first within "overdue" and within
  // "due_soon" alike).
  const orderingDue: OrderingDueAttentionItem[] = results
    .filter((r): r is typeof r & { status: "overdue" | "due_soon"; order_by: string; works_date: string } =>
      (r.status === "overdue" || r.status === "due_soon") && r.order_by !== null && r.works_date !== null
    )
    .map((r) => {
      const item = itemById.get(r.item_id)!;
      return {
        item_id: r.item_id,
        item_code: item.item_code,
        item_name: item.name,
        status: r.status,
        order_by: r.order_by,
        works_date: r.works_date,
        matched_preset_name: r.matched_preset?.name ?? null,
      };
    })
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === "overdue" ? -1 : 1;
      return a.order_by.localeCompare(b.order_by);
    });

  // href: deep-links straight to the FIRST missing-lead-time row when
  // one exists (same focus-id convention as My Work's decision_overdue/
  // ordering_due links — see ProcurementView.tsx's focus anchors), else
  // just the plain P&P tab (nothing to focus on — count is 0).
  const missingHref =
    missing.length > 0
      ? `/projects/${projectId}?tab=ffe&focus=ordering_due-${missing[0].item_id}`
      : `/projects/${projectId}?tab=ffe`;

  const body: ProjectAttentionResponse = {
    ordering_due: orderingDue,
    missing_lead_times: { count: missing.length, href: missingHref },
  };
  return NextResponse.json(body);
}
