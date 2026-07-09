// ============================================================
// RESLU Spec System — Daily Brief generator orchestration (migration
// 041). This is the ONE Supabase-touching module for the generator —
// mirrors lib/gmail/digest.ts's flushDigest() exact shape (takes a
// SupabaseClient, does the fetching + writing, returns a plain result
// object) rather than putting this much query logic directly in the
// route file. All TITLE/LINK/DEDUPE logic itself stays in
// lib/daily-brief.ts (pure, no Supabase import) — this file's own job
// is strictly "fetch the five source feeds' raw rows (reusing the
// SAME compute functions those feeds' own routes already call —
// lib/board-cockpit.ts's computeBookingsOverdue, lib/order-by.ts's
// deriveOrderBy, lib/leads.ts's computeAttentionGroups, lib/insurance.ts's
// computeInsuranceStatus — never re-deriving any of that logic here),
// hand the results to lib/daily-brief.ts's candidate builders, dedupe,
// and insert."
//
// See lib/daily-brief.ts's own header comment for the full generator
// idempotency story (why running this twice in one day produces zero
// duplicate rows).
// ============================================================

import type { SupabaseClient } from "@supabase/supabase-js";
import { computeBookingsOverdue, type BookingsOverdueSourceTask } from "@/lib/board-cockpit";
import {
  deriveOrderBy,
  type OrderByContactInput,
  type OrderByItemInput,
  type WorksDateSource,
} from "@/lib/order-by";
import { computeAttentionGroups } from "@/lib/leads";
import { computeInsuranceStatus } from "@/lib/insurance";
import { FALLBACK_EXPORT_PRESETS } from "@/lib/export-presets";
import {
  buildBookingCandidates,
  buildInsuranceCandidates,
  buildLeadCandidates,
  buildOrderingCandidates,
  buildTradeProposalCandidates,
  dedupeCandidates,
  type DailyBriefCandidate,
  type DailyBriefSource,
  type ExistingBriefItemForDedupe,
} from "@/lib/daily-brief";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { Lead, LeadStageEvent } from "@/types";

export interface GenerateDailyBriefResult {
  brief_date: string;
  created: number;
  by_source: Partial<Record<DailyBriefSource, number>>;
}

/** Adelaide-local "today", as a sortable yyyy-mm-dd string — same technique as app/api/digest/flush's own DST-safe cron slot check and this codebase's other isPastDue()-style fixes (see lib/time-format.ts's adelaideNowParts doc comment for the fullest write-up of why this beats a plain `Date` truncation for a server-cron caller). */
function adelaideToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(now);
}

/**
 * Runs the full generator: fetches all five source feeds, builds
 * candidates, dedupes against existing OPEN items, inserts whatever's
 * left. Uses the service-role client (passed in by the caller, same
 * "cron call has no session" reasoning as lib/gmail/digest.ts's
 * flushDigest) — brief items are team-wide regardless of RLS, and this
 * generator reads admin-only-sourced tables (leads, items'
 * lead_time_weeks) that a plain session client's RLS wouldn't block
 * anyway (Phase 1 "team_all" RLS is permissive everywhere — the ADMIN
 * GATE for leads/ordering data is enforced in the APP layer, at each
 * source route, not RLS) but using service-role here keeps this
 * generator consistent with every other cron-triggered writer in this
 * codebase.
 */
export async function generateDailyBrief(
  supabase: SupabaseClient,
  now: Date = new Date()
): Promise<GenerateDailyBriefResult> {
  const briefDate = adelaideToday(now);
  const candidates: DailyBriefCandidate[] = [];

  // ---- Existing OPEN items, fetched once up front (dedupe lookback
  // window is 7 days — pad one extra day for safety around the
  // Adelaide/UTC calendar-day boundary). ----
  const lookbackFloor = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data: existingRows } = await supabase
    .from("daily_brief_items")
    .select("source,link_href,status,brief_date")
    .eq("status", "open")
    .gte("brief_date", lookbackFloor);
  const existing = (existingRows ?? []) as ExistingBriefItemForDedupe[];

  // ---- 1. source: booking — bookings_overdue (reason
  // 'booking_unconfirmed' only; 'milestone_overdue' cards have no
  // booking to chase — BUILD-SPEC's "Book {task}" wording is about the
  // unconfirmed-booking case specifically, and a milestone due-date
  // slip is a plain due-date reminder better left to the task's own
  // due_date/board surfacing rather than a second, differently-worded
  // brief item). ----
  const { data: bookingRows } = await supabase
    .from("board_tasks")
    .select("id,title,project_id,kind,due_date,booking_date,visit_id,contact_id")
    .is("deleted_at", null)
    .or("booking_date.not.is.null,and(kind.eq.milestone,due_date.not.is.null)");
  const bookingTaskRows = bookingRows ?? [];
  const visitIds = [...new Set(bookingTaskRows.map((r) => r.visit_id).filter(Boolean))] as string[];
  const { data: visitStatusRows } = visitIds.length
    ? await supabase.from("trade_visits").select("id,status").in("id", visitIds)
    : { data: [] as { id: string; status: string }[] };
  const visitStatusById = new Map((visitStatusRows ?? []).map((v) => [v.id, v.status]));

  const bookingSourceTasks: BookingsOverdueSourceTask[] = bookingTaskRows.map((r) => ({
    id: r.id,
    title: r.title,
    project_id: r.project_id,
    kind: r.kind,
    due_date: r.due_date,
    booking_date: r.booking_date,
    visit_status: (r.visit_id ? (visitStatusById.get(r.visit_id) as BookingsOverdueSourceTask["visit_status"]) : null) ?? null,
    contact_id: r.contact_id,
  }));
  const bookingTaskById = new Map(bookingTaskRows.map((r) => [r.id, r]));
  const overdueBookings = computeBookingsOverdue(bookingSourceTasks, now).filter(
    (o) => o.reason === "booking_unconfirmed"
  );
  candidates.push(
    ...buildBookingCandidates(
      overdueBookings.map((o) => {
        const t = bookingTaskById.get(o.task_id)!;
        return { task_id: o.task_id, task_title: t.title, project_id: t.project_id, date: o.date };
      })
    )
  );

  // ---- 2. source: ordering — ordering_due rollup, same (project,
  // matched preset) grouping GET /api/my-work's own source #9 uses. ----
  const { data: unorderedItems } = await supabase
    .from("items")
    .select("id,project_id,category,lead_time_weeks,ordered_at")
    .is("deleted_at", null)
    .is("ordered_at", null);
  const itemRows = (unorderedItems ?? []) as OrderByItemInput[];

  if (itemRows.length > 0) {
    const projectIds = [...new Set(itemRows.map((i) => i.project_id))];
    const [{ data: presetSetting }, { data: allVisits }, { data: allBookedTasks }] = await Promise.all([
      supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
      supabase
        .from("trade_visits")
        .select("id,project_id,contact_id,start_date,status")
        .in("project_id", projectIds)
        .is("deleted_at", null)
        .neq("status", "declined"),
      supabase
        .from("board_tasks")
        .select("id,project_id,contact_id,booking_date")
        .in("project_id", projectIds)
        .is("deleted_at", null)
        .not("booking_date", "is", null),
    ]);

    const presets = (presetSetting?.value as ExportPresetRow[] | undefined) ?? FALLBACK_EXPORT_PRESETS;

    const orderingSources: WorksDateSource[] = [
      ...((allVisits ?? []) as { id: string; project_id: string; contact_id: string | null; start_date: string }[]).map((v) => ({
        source_id: v.id,
        source_kind: "visit" as const,
        project_id: v.project_id,
        contact_id: v.contact_id,
        start_date: v.start_date,
      })),
      ...((allBookedTasks ?? []) as { id: string; project_id: string; contact_id: string | null; booking_date: string | null }[])
        .filter((t) => t.booking_date)
        .map((t) => ({
          source_id: t.id,
          source_kind: "board_task_booking" as const,
          project_id: t.project_id,
          contact_id: t.contact_id,
          start_date: t.booking_date as string,
        })),
    ];

    const orderingContactIds = [...new Set(orderingSources.map((s) => s.contact_id).filter(Boolean))] as string[];
    const { data: orderingContactRows } = orderingContactIds.length
      ? await supabase.from("contacts").select("id,category").in("id", orderingContactIds).is("deleted_at", null)
      : { data: [] as { id: string; category: string | null }[] };
    const orderingContacts: OrderByContactInput[] = (orderingContactRows ?? []).map((c) => ({ id: c.id, category: c.category }));

    const orderingResults = deriveOrderBy(itemRows, presets, orderingContacts, orderingSources, now);
    const dueOrOverdue = orderingResults.filter((r) => r.status === "due_soon" || r.status === "overdue");
    const itemById = new Map(itemRows.map((i) => [i.id, i]));

    const rollup = new Map<
      string,
      { project_id: string; preset_name: string; count: number; earliest_order_by: string; earliest_works_date: string; first_item_id: string }
    >();
    for (const r of dueOrOverdue) {
      const item = itemById.get(r.item_id);
      if (!item || !r.order_by || !r.works_date) continue;
      const presetName = r.matched_preset?.name ?? "Unmapped trade";
      const key = `${item.project_id}::${presetName}`;
      const existingGroup = rollup.get(key);
      if (!existingGroup) {
        rollup.set(key, {
          project_id: item.project_id,
          preset_name: presetName,
          count: 1,
          earliest_order_by: r.order_by,
          earliest_works_date: r.works_date,
          first_item_id: r.item_id,
        });
      } else {
        existingGroup.count += 1;
        if (r.order_by < existingGroup.earliest_order_by) existingGroup.earliest_order_by = r.order_by;
        if (r.works_date < existingGroup.earliest_works_date) existingGroup.earliest_works_date = r.works_date;
      }
    }

    candidates.push(...buildOrderingCandidates([...rollup.values()]));
  }

  // ---- 3. source: lead — nurture + stale_proposals only (per
  // BUILD-SPEC's own "nurture/stale entries"; follow_ups_due and
  // site_visits_upcoming are NOT brief material — those already have
  // their own dedicated My Work source (#2) and Leads-page surfacing). ----
  const { data: leadRows } = await supabase.from("leads").select("*").is("deleted_at", null);
  const typedLeads = (leadRows ?? []) as Lead[];
  const stageTrackedIds = typedLeads
    .filter((l) => l.stage === "Proposal Sent" || l.stage === "Awaiting to Send Proposal")
    .map((l) => l.id);
  const eventsByLead = new Map<string, LeadStageEvent[]>();
  if (stageTrackedIds.length > 0) {
    const { data: events } = await supabase.from("lead_stage_events").select("*").in("lead_id", stageTrackedIds);
    for (const e of (events ?? []) as LeadStageEvent[]) {
      const arr = eventsByLead.get(e.lead_id) ?? [];
      arr.push(e);
      eventsByLead.set(e.lead_id, arr);
    }
  }
  const leadGroups = computeAttentionGroups(typedLeads, eventsByLead, now);
  candidates.push(
    ...buildLeadCandidates(
      leadGroups.nurture.map((l) => ({ id: l.id, surname_project: l.surname_project })),
      leadGroups.stale_proposals.map((l) => ({ id: l.id, surname_project: l.surname_project }))
    )
  );

  // ---- 4. source: trade — trade proposed_change ----
  const { data: proposalRows } = await supabase
    .from("trade_visits")
    .select("id,project_id,contact_id")
    .eq("status", "proposed_change")
    .is("deleted_at", null);
  const proposals = proposalRows ?? [];
  const proposalContactIds = [...new Set(proposals.map((p) => p.contact_id).filter(Boolean))] as string[];
  const { data: proposalContacts } = proposalContactIds.length
    ? await supabase.from("contacts").select("id,company").in("id", proposalContactIds)
    : { data: [] as { id: string; company: string }[] };
  const companyByContactId = new Map((proposalContacts ?? []).map((c) => [c.id, c.company]));
  candidates.push(
    ...buildTradeProposalCandidates(
      proposals.map((p) => ({
        visit_id: p.id,
        project_id: p.project_id,
        contact_company: p.contact_id ? companyByContactId.get(p.contact_id) ?? null : null,
      }))
    )
  );

  // ---- 5. source: trade — expiring/expired insurance ----
  const { data: allContacts } = await supabase.from("contacts").select("id,company,insurance_required").is("deleted_at", null);
  const contactRows = allContacts ?? [];
  const contactIds = contactRows.map((c) => c.id);
  if (contactIds.length > 0) {
    const { data: allDocs } = await supabase
      .from("contact_documents")
      .select("contact_id,kind,expiry_date,deleted_at")
      .in("contact_id", contactIds)
      .is("deleted_at", null)
      .in("kind", ["public_liability", "workers_comp"]);
    const docsByContact = new Map<string, { kind: "public_liability" | "workers_comp"; expiry_date: string | null; deleted_at: string | null }[]>();
    for (const d of allDocs ?? []) {
      const list = docsByContact.get(d.contact_id) ?? [];
      list.push(d as { kind: "public_liability" | "workers_comp"; expiry_date: string | null; deleted_at: string | null });
      docsByContact.set(d.contact_id, list);
    }
    const insuranceRows: { contact_id: string; company: string; status: "expiring" | "expired" }[] = [];
    for (const c of contactRows) {
      const docs = docsByContact.get(c.id) ?? [];
      const status = computeInsuranceStatus(c.insurance_required, docs, now);
      if (status === "expiring" || status === "expired") {
        insuranceRows.push({ contact_id: c.id, company: c.company, status });
      }
    }
    candidates.push(...buildInsuranceCandidates(insuranceRows));
  }

  // ---- Dedupe against existing open items, then insert whatever's
  // left. A defensive in-run de-dupe (same source+link_href appearing
  // twice from two different candidate builders) is also applied —
  // shouldn't normally happen given each builder's own grouping, but
  // costs nothing to guard. ----
  const afterExistingDedupe = dedupeCandidates(candidates, existing, now);
  const seen = new Set<string>();
  const rowsToInsert: { brief_date: string; title: string; source: DailyBriefSource; link_href: string; status: "open"; created_by_kind: "system"; project_id: string | null }[] = [];
  const bySource: Partial<Record<DailyBriefSource, number>> = {};

  for (const c of afterExistingDedupe) {
    const key = `${c.source}::${c.link_href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rowsToInsert.push({
      brief_date: briefDate,
      title: c.title,
      source: c.source,
      link_href: c.link_href,
      status: "open",
      created_by_kind: "system",
      project_id: c.project_id,
    });
    bySource[c.source] = (bySource[c.source] ?? 0) + 1;
  }

  if (rowsToInsert.length > 0) {
    const { error } = await supabase.from("daily_brief_items").insert(rowsToInsert);
    if (error) throw new Error(`Daily Brief generator insert failed: ${error.message}`);
  }

  return { brief_date: briefDate, created: rowsToInsert.length, by_source: bySource };
}
