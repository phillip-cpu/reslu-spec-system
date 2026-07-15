import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { resolveExportPresets } from "@/lib/export-presets";
import { deriveOrderBy, missingLeadTimes, type OrderByContactInput, type OrderByItemInput, type WorksDateSource } from "@/lib/order-by";
import type { OrderByResponse, OrderByRow } from "@/types/order-by";

export const runtime = "nodejs";

/**
 * GET /api/projects/[id]/order-by
 * "Order-by engine — product deadlines from trade bookings" (Phillip,
 * 8 July 2026). Admin-only, server-enforced — order_by data is
 * procurement-sensitive (derived directly from lead_time_weeks, which
 * lives in the Pricing & Procurement view only, and from trade
 * bookings) — mirrors GET /api/projects/[id]/estimate's EXACT gating
 * shape (info.role !== "admin" -> 403, before any query runs) rather
 * than the team-visible pattern GET /api/visits/attention or GET
 * /api/board-tasks/attention use (those are scheduling data with no
 * price/procurement content; this route's whole purpose is procurement
 * timing derived from a field — lead_time_weeks — that ProcurementView
 * itself already treats as P&P-only).
 *
 * Fetches everything lib/order-by.ts's deriveOrderBy()/missingLeadTimes()
 * need, scoped to this one project:
 *   - items: only unordered (ordered_at is null), non-deleted, this
 *     project. lead_time_weeks/category/ordered_at only — no pricing
 *     columns are selected here (price_trade/price_rrp/markup_pct never
 *     leave the DB via this route), consistent with this route's own
 *     "procurement timing, not pricing" scope even though the ROUTE
 *     itself is admin-gated regardless.
 *   - presets: app_settings('export_presets'), same fallback-to-code
 *     convention as GET /api/settings/export-presets.
 *   - contacts: every non-deleted contact referenced by a candidate
 *     works-date source (trade_visits.contact_id / board_tasks.contact_id)
 *     for this project — never every contact company-wide, keeping this
 *     a bounded, project-scoped query.
 *   - sources: trade_visits (status != 'declined', not soft-deleted)
 *     normalised to WorksDateSource, PLUS board_tasks booking
 *     placeholders (booking_date not null, not soft-deleted) similarly
 *     normalised — see lib/order-by.ts's WorksDateSource doc comment
 *     for why a declined visit is filtered out here rather than inside
 *     the pure module itself.
 *
 * Response: OrderByRow[] for every unordered item that has EITHER a
 * relevant works date OR is missing a lead time (i.e. anything the UI
 * would render a non-'—'/non-blank chip for) — 'ok' items far in the
 * future are included too (BUILD-SPEC's chip needs a date to show even
 * when it's not yet due-soon), simply not flagged. Items with status
 * 'no_booking' AND a lead time set are also included (so the '—' chip
 * renders) — in short, `rows` covers every unordered item in the
 * project, one row each, since deriveOrderBy() itself already scopes to
 * "unordered" and this per-project route has no reason to filter
 * further. `missing_lead_time_item_ids` is missingLeadTimes()'s
 * project-scoped output, exposed separately per lib/order-by.ts's own
 * doc comment on why it's not folded into `rows`.
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
      { error: "Only admins can access order-by data" },
      { status: 403 }
    );
  }

  const [{ data: itemRows, error: itemsError }, { data: presetSetting }] = await Promise.all([
    supabase
      .from("items")
      .select("id,project_id,category,lead_time_weeks,ordered_at")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .is("ordered_at", null),
    supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
  ]);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }

  const items = (itemRows ?? []) as OrderByItemInput[];
  const presets = resolveExportPresets(presetSetting?.value);

  if (items.length === 0) {
    const body: OrderByResponse = { rows: [], missing_lead_time_item_ids: [] };
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
    // Board-task booking placeholders that ALSO carry a visit_id (i.e.
    // a real trade_visits row already exists and was booked via "Book
    // trade") are intentionally NOT de-duplicated against the visit
    // list above — both a board_tasks.booking_date row and its linked
    // trade_visits.start_date row carry the SAME date (migration 029's
    // own "kept in sync at the two write sites" invariant — see that
    // migration's PART 1 comment), so including both is harmless
    // (pickEarliestSource() just sees the same date twice, changing
    // nothing about which date wins) and keeps this route from needing
    // to special-case linked-vs-unlinked cards.
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
    ? await supabase.from("contacts").select("id,company,contact_name,category").in("id", contactIds).is("deleted_at", null)
    : { data: [] as { id: string; company: string; contact_name: string | null; category: string | null }[] };

  const contacts: OrderByContactInput[] = (contactRows ?? []).map((c) => ({ id: c.id, category: c.category }));
  const contactSummaryById = new Map(
    (contactRows ?? []).map((c) => [c.id, { id: c.id, company: c.company, contact_name: c.contact_name }])
  );

  const results = deriveOrderBy(items, presets, contacts, sources);
  const missing = missingLeadTimes(items);

  const rows: OrderByRow[] = results.map((r) => ({
    item_id: r.item_id,
    status: r.status,
    order_by: r.order_by,
    works_date: r.works_date,
    matched_preset_name: r.matched_preset?.name ?? null,
    matched_contact: r.source?.contact_id ? contactSummaryById.get(r.source.contact_id) ?? null : null,
  }));

  const body: OrderByResponse = {
    rows,
    missing_lead_time_item_ids: missing.map((m) => m.item_id),
  };
  return NextResponse.json(body);
}
