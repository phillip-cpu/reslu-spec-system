import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { groupMyWorkItems } from "@/lib/my-work";
import { computeInsuranceStatus } from "@/lib/insurance";
import { FALLBACK_EXPORT_PRESETS } from "@/lib/export-presets";
import { deriveOrderBy, formatOrderByWorksDate, type OrderByContactInput, type OrderByItemInput, type WorksDateSource } from "@/lib/order-by";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { MyWorkItem, MyWorkResponse } from "@/types/phase-12a-b";

export const runtime = "nodejs";

/** Board cockpit round — "DD/MM" formatting for the My Work board_task title suffix (see source #1 below). Deliberately NOT locale-formatted (no Intl/toLocaleDateString) — a fixed DD/MM matches this codebase's other short inline date renderings (e.g. GanttChart.tsx's formatShortDate-style helpers) and avoids any timezone-shift surprise for a date-only (yyyy-mm-dd) column. */
function formatWorksDate(dateOnly: string): string {
  const [, month, day] = dateOnly.split("-");
  return `${day}/${month}`;
}

/**
 * GET /api/my-work
 * Per-user aggregator — BUILD-SPEC.md §"Phase 12a — My Work": "today /
 * this week / overdue groupings across: board_tasks assigned to me
 * (due dates), lead follow-ups (admin), diary drafts pending my
 * approval, trade-visit proposals awaiting response, overdue client
 * decisions (decision_needed_by past)." This task's brief additionally
 * names a fourth "No date" bucket (see lib/my-work.ts's doc comment).
 *
 * Six source queries, each independently optional (a query failing or
 * returning nothing never blocks the others — this route degrades
 * gracefully rather than 500ing the whole page because, say, no leads
 * table rows match):
 *
 *   1. board_tasks assigned to me, via board_task_assignees (Board v2
 *      multi-assignee join) — due_date drives bucketing.
 *   2. Lead follow-ups (admin-only): leads.follow_up_date due/past —
 *      team-visible members simply see nothing in this source (not an
 *      error), mirroring lib/leads.ts's own admin-only framing.
 *   3. Diary drafts pending approval: portal_updates where status =
 *      'pending_approval' — team-visible (publishing is a team action,
 *      not admin-gated elsewhere in this codebase either).
 *   4. Trade-visit proposals awaiting response: trade_visits where
 *      status = 'proposed_change' — team-visible (scheduling data).
 *   5. Items past decision_needed_by: items where decision_needed_by <
 *      today AND client_approved/client_flagged both still false (i.e.
 *      genuinely still awaiting a decision) — team-visible, "no
 *      pricing" per this task's verification note (only item_code,
 *      name, location, decision_needed_by are ever selected here,
 *      matching the portal's own PORTAL_FIELDS whitelist philosophy —
 *      no price_trade/price_rrp/markup_pct/price_client column is ever
 *      touched by this route).
 *   6. Phase 13 — Office board tasks assigned to me, via
 *      office_task_assignees, EXCLUDING kind 'rule' (standing rule
 *      cards are never "my work" — they're pinned notices, not
 *      to-dos an individual owns) and excluding already-completed
 *      tasks (completed_at not null — a done task shouldn't keep
 *      nagging in My Work once archived). due_date drives bucketing,
 *      same as board_task.
 *   7. Fix Round A — Trade insurance expiring/expired: contacts with
 *      insurance_required = true (migration 026, Quick items round 6
 *      July 2026 — a human-ticked "Certificate needed" checkbox,
 *      replacing the former category heuristic) whose computed
 *      insurance_status is 'expiring' or 'expired' (never 'missing' —
 *      a contact with NO documents on file has no expiry date to
 *      bucket by day, so it has no natural `due` and would only ever
 *      land in My Work's "No date" bucket; it still surfaces via GET
 *      /api/contacts/attention's dedicated `missing` list and the
 *      Address Book badge instead). `due` = the earliest expiring/
 *      already-past qualifying document's expiry_date, so the bucket
 *      (overdue/today/this week) reflects how urgent THIS contact's
 *      compliance gap is. Team-visible, not admin-gated (BUILD-SPEC.md
 *      "Trade insurance compliance" carries no financial data).
 *      Additive per this task's brief ("find and extend additively")
 *      — mirrors the exact pattern Phase 13's office_task source
 *      established (see MyWorkItemKind's own doc comment,
 *      types/phase-12a-b.ts).
 *   8. Phase 12b — Design Framework tasks assigned to me
 *      (design_tasks via design_task_assignees), same shape as source
 *      #1's board_task join, EXCLUDING already-completed tasks
 *      (completed_at not null). due_date drives bucketing; `meta` is
 *      always the literal string "Design" (this task's brief: "join
 *      the aggregator with a 'Design' context chip") rather than the
 *      phase name, since the phase name is already visible one click
 *      away on the Design tab and a fixed short chip label is more
 *      scannable in a dense cross-source feed than seven different
 *      per-phase labels would be. Team-visible, not admin-gated (no
 *      pricing data). Purely additive — mirrors office_task/
 *      insurance_expiring's exact "new source block, nothing else
 *      touched" pattern.
 *
 * None of these eight sources require a project-membership check (this
 * codebase has no per-project team assignment — every team member sees
 * every project, per BUILD-SPEC.md §Security's Phase 1 "all team equal"
 * baseline), so no extra ownership filtering is needed beyond the
 * per-source filters described above.
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { userId, role } = info;
  const isAdmin = role === "admin";
  const items: MyWorkItem[] = [];

  // ---- 1. My board tasks (via board_task_assignees) ----
  const { data: myAssignments } = await supabase
    .from("board_task_assignees")
    .select("task_id")
    .eq("profile_id", userId);

  const myTaskIds = (myAssignments ?? []).map((a) => a.task_id);
  if (myTaskIds.length > 0) {
    const { data: tasks } = await supabase
      .from("board_tasks")
      // migration 041 — due_time added alongside due_date (see source #1's push below).
      .select("id,project_id,column_id,title,due_date,due_time,booking_date")
      .in("id", myTaskIds)
      .is("deleted_at", null);

    const taskRows = tasks ?? [];
    const projectIds = [...new Set(taskRows.map((t) => t.project_id))];
    const columnIds = [...new Set(taskRows.map((t) => t.column_id))];

    const [{ data: projects }, { data: columns }] = await Promise.all([
      projectIds.length
        ? supabase.from("projects").select("id,name,alias").in("id", projectIds)
        : Promise.resolve({ data: [] as { id: string; name: string; alias: string | null }[] }),
      columnIds.length
        ? supabase.from("board_columns").select("id,name").in("id", columnIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    ]);

    const projectById = new Map((projects ?? []).map((p) => [p.id, p]));
    const columnById = new Map((columns ?? []).map((c) => [c.id, c]));

    for (const t of taskRows) {
      const project = projectById.get(t.project_id);
      items.push({
        kind: "board_task",
        id: t.id,
        // Board cockpit round — additive "works <DD/MM>" suffix when
        // this card carries a booking_date (the booked trade-visit
        // window's start, migration 029), so a My Work row surfaces
        // the booking date alongside the ordinary due-date bucketing
        // without a new MyWorkItem field: behaviour is UNCHANGED for
        // every card with no booking_date (the common case, and every
        // other source in this route), the suffix only ever appends.
        title: t.booking_date ? `${t.title} — works ${formatWorksDate(t.booking_date)}` : t.title,
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        due: t.due_date,
        due_time: t.due_time,
        href: `/projects/${t.project_id}/board?focus=board_task-${t.id}`,
        meta: columnById.get(t.column_id)?.name ?? null,
      });
    }
  }

  // ---- 2. Lead follow-ups (admin only) ----
  if (isAdmin) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const { data: leads } = await supabase
      .from("leads")
      .select("id,surname_project,location,follow_up_date")
      .is("deleted_at", null)
      .lte("follow_up_date", today.toISOString().slice(0, 10))
      .not("follow_up_date", "is", null);

    for (const lead of leads ?? []) {
      items.push({
        kind: "lead_follow_up",
        id: lead.id,
        title: lead.surname_project,
        project: null,
        due: lead.follow_up_date,
        href: `/leads`,
        meta: lead.location ?? "Lead follow-up",
      });
    }
  }

  // ---- 3. Diary drafts pending approval ----
  const { data: drafts } = await supabase
    .from("portal_updates")
    .select("id,project_id,title,updated_at")
    .eq("status", "pending_approval")
    .is("deleted_at", null);

  if (drafts && drafts.length > 0) {
    const projectIds = [...new Set(drafts.map((d) => d.project_id))];
    const { data: projects } = await supabase.from("projects").select("id,name,alias").in("id", projectIds);
    const projectById = new Map((projects ?? []).map((p) => [p.id, p]));

    for (const d of drafts) {
      const project = projectById.get(d.project_id);
      items.push({
        kind: "diary_draft",
        id: d.id,
        title: d.title || "Untitled diary entry",
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        // Diary drafts have no natural due date — use updated_at (when
        // it was submitted for approval) as the sort/bucket anchor, per
        // this file's MyWorkItem doc comment.
        due: d.updated_at ? d.updated_at.slice(0, 10) : null,
        href: `/projects/${d.project_id}/client?tab=diary&focus=diary_draft-${d.id}`,
        meta: "Awaiting publish",
      });
    }
  }

  // ---- 4. Trade-visit proposals awaiting response ----
  const { data: proposals } = await supabase
    .from("trade_visits")
    .select("id,project_id,contact_id,proposed_start,updated_at")
    .eq("status", "proposed_change")
    .is("deleted_at", null);

  if (proposals && proposals.length > 0) {
    const projectIds = [...new Set(proposals.map((p) => p.project_id))];
    const contactIds = [...new Set(proposals.map((p) => p.contact_id).filter(Boolean))] as string[];
    const [{ data: projects }, { data: contacts }] = await Promise.all([
      supabase.from("projects").select("id,name,alias").in("id", projectIds),
      contactIds.length
        ? supabase.from("contacts").select("id,company").in("id", contactIds)
        : Promise.resolve({ data: [] as { id: string; company: string }[] }),
    ]);
    const projectById = new Map((projects ?? []).map((p) => [p.id, p]));
    const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

    for (const p of proposals) {
      const project = projectById.get(p.project_id);
      items.push({
        kind: "trade_proposal",
        id: p.id,
        title: contactById.get(p.contact_id ?? "")?.company
          ? `${contactById.get(p.contact_id ?? "")?.company} proposed a new time`
          : "Trade proposed a new time",
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        due: p.proposed_start ?? (p.updated_at ? p.updated_at.slice(0, 10) : null),
        href: `/projects/${p.project_id}/timeline?focus=trade_proposal-${p.id}`,
        meta: "Needs a response",
      });
    }
  }

  // ---- 5. Overdue client decisions (decision_needed_by past, no pricing) ----
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const { data: overdueItems } = await supabase
    .from("items")
    .select("id,project_id,item_code,name,location,decision_needed_by")
    .is("deleted_at", null)
    .not("decision_needed_by", "is", null)
    .lt("decision_needed_by", today.toISOString().slice(0, 10))
    .eq("client_approved", false)
    .eq("client_flagged", false);

  if (overdueItems && overdueItems.length > 0) {
    const projectIds = [...new Set(overdueItems.map((i) => i.project_id))];
    const { data: projects } = await supabase.from("projects").select("id,name,alias").in("id", projectIds);
    const projectById = new Map((projects ?? []).map((p) => [p.id, p]));

    for (const i of overdueItems) {
      const project = projectById.get(i.project_id);
      items.push({
        kind: "decision_overdue",
        id: i.id,
        title: `${i.item_code} — ${i.name}`,
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        due: i.decision_needed_by,
        // "items may target the P&P view row (ProcurementView) as
        // interim" (see docs/HANDOFF-focus-register.md) — SpecRegister
        // itself is protected for this task, so the focus id this
        // points at lives in ProcurementView.tsx, not the register.
        href: `/projects/${i.project_id}?tab=ffe&focus=decision_overdue-${i.id}`,
        meta: i.location ?? "Awaiting client decision",
      });
    }
  }

  // ---- 6. Office board tasks assigned to me (Phase 13) ----
  const { data: myOfficeAssignments } = await supabase
    .from("office_task_assignees")
    .select("task_id")
    .eq("profile_id", userId);

  const myOfficeTaskIds = (myOfficeAssignments ?? []).map((a) => a.task_id);
  if (myOfficeTaskIds.length > 0) {
    const { data: officeTasks } = await supabase
      .from("office_tasks")
      // migration 041 — due_time added alongside due_date (see source #6's push below).
      .select("id,group_id,title,due_date,due_time,kind,completed_at")
      .in("id", myOfficeTaskIds)
      .is("deleted_at", null)
      .eq("kind", "task")
      .is("completed_at", null);

    const officeTaskRows = officeTasks ?? [];
    const groupIds = [...new Set(officeTaskRows.map((t) => t.group_id))];
    const { data: officeGroups } = groupIds.length
      ? await supabase.from("office_groups").select("id,name").in("id", groupIds)
      : { data: [] as { id: string; name: string }[] };
    const groupById = new Map((officeGroups ?? []).map((g) => [g.id, g]));

    for (const t of officeTaskRows) {
      items.push({
        kind: "office_task",
        id: t.id,
        title: t.title,
        project: null,
        due: t.due_date,
        due_time: t.due_time,
        href: `/office?focus=office_task-${t.id}`,
        meta: groupById.get(t.group_id)?.name ?? "Office",
      });
    }
  }

  // ---- 7. Fix Round A — Trade insurance expiring/expired ----
  // Quick items round (6 July 2026): `insurance_required` (migration
  // 026, a human-ticked checkbox) drives this now, not a category
  // guess — see lib/insurance.ts's header comment.
  const { data: allContacts } = await supabase
    .from("contacts")
    .select("id,company,insurance_required")
    .is("deleted_at", null);
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

    for (const c of contactRows) {
      const docs = docsByContact.get(c.id) ?? [];
      const status = computeInsuranceStatus(c.insurance_required, docs);
      if (status !== "expiring" && status !== "expired") continue;

      // Earliest qualifying expiry_date drives `due` (most urgent gap first).
      const expiryDates = docs.map((d) => d.expiry_date).filter((d): d is string => !!d).sort();
      items.push({
        kind: "insurance_expiring",
        id: c.id,
        title: `${c.company} — insurance ${status}`,
        project: null,
        due: expiryDates[0] ?? null,
        href: "/contacts",
        meta: status === "expired" ? "Insurance expired" : "Insurance expiring soon",
      });
    }
  }

  // ---- 8. Design Framework tasks assigned to me (Phase 12b) ----
  const { data: myDesignAssignments } = await supabase
    .from("design_task_assignees")
    .select("task_id")
    .eq("profile_id", userId);

  const myDesignTaskIds = (myDesignAssignments ?? []).map((a) => a.task_id);
  if (myDesignTaskIds.length > 0) {
    const { data: designTasks } = await supabase
      .from("design_tasks")
      // migration 041 — due_time added alongside due_date (see source #8's push below).
      .select("id,design_phase_id,title,due_date,due_time,completed_at")
      .in("id", myDesignTaskIds)
      .is("deleted_at", null)
      .is("completed_at", null)
      .not("due_date", "is", null);

    const designTaskRows = designTasks ?? [];
    const phaseIds = [...new Set(designTaskRows.map((t) => t.design_phase_id))];
    const { data: designPhases } = phaseIds.length
      ? await supabase.from("design_phases").select("id,project_id").in("id", phaseIds)
      : { data: [] as { id: string; project_id: string }[] };
    const phaseById = new Map((designPhases ?? []).map((p) => [p.id, p]));

    const designProjectIds = [...new Set((designPhases ?? []).map((p) => p.project_id))];
    const { data: designProjects } = designProjectIds.length
      ? await supabase.from("projects").select("id,name,alias").in("id", designProjectIds)
      : { data: [] as { id: string; name: string; alias: string | null }[] };
    const designProjectById = new Map((designProjects ?? []).map((p) => [p.id, p]));

    for (const t of designTaskRows) {
      const phase = phaseById.get(t.design_phase_id);
      const project = phase ? designProjectById.get(phase.project_id) : undefined;
      items.push({
        kind: "design_task",
        id: t.id,
        title: t.title,
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        due: t.due_date,
        due_time: t.due_time,
        href: project ? `/projects/${project.id}/design?focus=design_task-${t.id}` : "/",
        meta: "Design",
      });
    }
  }

  // ---- 9. Order-by engine — ordering_due rollup (admin only) ----
  // BUILD-SPEC.md "Order-by engine" item 3: "My Work rollup line per
  // project ('Order 4 items for Carpentry — works 21 Jul', links to
  // P&P filtered)". Admin-only — this surfaces P&P/procurement data
  // (lead_time_weeks, order_by), same gating as source #2's lead
  // follow-ups: an identical `if (isAdmin) { ... }` block, not a new
  // gating mechanism.
  //
  // One line PER (project, matched preset name) pair with at least one
  // due_soon/overdue item — e.g. two projects each needing Carpentry
  // orders produce two separate lines (each with its own project chip
  // and deep link), and one project needing both Carpentry and
  // Plumbing orders produces two lines for that one project. `due` is
  // the line's own order_by date (the earliest one among its grouped
  // items, so the bucket reflects the most urgent item in that group);
  // the title's "works <date>" suffix uses the EARLIEST matching works
  // date across the group for the same reason. This mirrors board_task
  // source #1's "works <DD/MM>" suffix formatting via
  // lib/order-by.ts's formatOrderByWorksDate() (identical DD/MM, no
  // locale formatting — same fixed short-date convention this file's
  // own formatWorksDate() already established for booking_date).
  if (isAdmin) {
    const { data: unorderedItems } = await supabase
      .from("items")
      .select("id,project_id,category,lead_time_weeks,ordered_at")
      .is("deleted_at", null)
      .is("ordered_at", null);

    const itemRows = (unorderedItems ?? []) as OrderByItemInput[];

    if (itemRows.length > 0) {
      const projectIdsForOrdering = [...new Set(itemRows.map((i) => i.project_id))];

      const [{ data: presetSetting }, { data: allVisits }, { data: allBookedTasks }] = await Promise.all([
        supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
        supabase
          .from("trade_visits")
          .select("id,project_id,contact_id,start_date,status")
          .in("project_id", projectIdsForOrdering)
          .is("deleted_at", null)
          .neq("status", "declined"),
        supabase
          .from("board_tasks")
          .select("id,project_id,contact_id,booking_date")
          .in("project_id", projectIdsForOrdering)
          .is("deleted_at", null)
          .not("booking_date", "is", null),
      ]);

      const presets = (presetSetting?.value as ExportPresetRow[] | undefined) ?? FALLBACK_EXPORT_PRESETS;

      const orderingSources: WorksDateSource[] = [
        ...((allVisits ?? []) as { id: string; project_id: string; contact_id: string | null; start_date: string }[]).map(
          (v) => ({
            source_id: v.id,
            source_kind: "visit" as const,
            project_id: v.project_id,
            contact_id: v.contact_id,
            start_date: v.start_date,
          })
        ),
        ...(
          (allBookedTasks ?? []) as { id: string; project_id: string; contact_id: string | null; booking_date: string | null }[]
        )
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
        ? await supabase
            .from("contacts")
            .select("id,category")
            .in("id", orderingContactIds)
            .is("deleted_at", null)
        : { data: [] as { id: string; category: string | null }[] };
      const orderingContacts: OrderByContactInput[] = (orderingContactRows ?? []).map((c) => ({
        id: c.id,
        category: c.category,
      }));

      const orderingResults = deriveOrderBy(itemRows, presets, orderingContacts, orderingSources);
      const dueOrOverdue = orderingResults.filter((r) => r.status === "due_soon" || r.status === "overdue");

      if (dueOrOverdue.length > 0) {
        const orderingProjectIds = [...new Set(dueOrOverdue.map((r) => itemRows.find((i) => i.id === r.item_id)?.project_id))].filter(
          (id): id is string => !!id
        );
        const { data: orderingProjects } = await supabase
          .from("projects")
          .select("id,name,alias")
          .in("id", orderingProjectIds);
        const orderingProjectById = new Map((orderingProjects ?? []).map((p) => [p.id, p]));
        const itemById = new Map(itemRows.map((i) => [i.id, i]));

        // Group by (project_id, matched preset name) — a Map keyed by a
        // joined string since plain objects can't key on a tuple.
        // `first_item_id` is whichever item first populated this group
        // (order of iteration over dueOrOverdue) — used only to build a
        // deep link that focuses on ONE representative row in
        // ProcurementView, not a claim about which item is "most"
        // representative.
        const rollup = new Map<
          string,
          {
            project_id: string;
            preset_name: string;
            count: number;
            earliest_order_by: string;
            earliest_works_date: string;
            first_item_id: string;
          }
        >();

        for (const r of dueOrOverdue) {
          const item = itemById.get(r.item_id);
          if (!item || !r.order_by || !r.works_date) continue;
          const presetName = r.matched_preset?.name ?? "Unmapped trade";
          const key = `${item.project_id}::${presetName}`;
          const existing = rollup.get(key);
          if (!existing) {
            rollup.set(key, {
              project_id: item.project_id,
              preset_name: presetName,
              count: 1,
              earliest_order_by: r.order_by,
              earliest_works_date: r.works_date,
              first_item_id: r.item_id,
            });
          } else {
            existing.count += 1;
            if (r.order_by < existing.earliest_order_by) existing.earliest_order_by = r.order_by;
            if (r.works_date < existing.earliest_works_date) existing.earliest_works_date = r.works_date;
          }
        }

        for (const [key, group] of rollup) {
          const project = orderingProjectById.get(group.project_id);
          items.push({
            kind: "ordering_due",
            id: key,
            title: `Order ${group.count} item${group.count === 1 ? "" : "s"} for ${group.preset_name} — works ${formatOrderByWorksDate(group.earliest_works_date)}`,
            project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
            due: group.earliest_order_by,
            href: `/projects/${group.project_id}?tab=ffe&focus=ordering_due-${group.first_item_id}`,
            meta: "Ordering due",
          });
        }
      }
    }
  }

  const groups = groupMyWorkItems(items);
  const body: MyWorkResponse = { groups, is_admin: isAdmin };
  return NextResponse.json(body);
}
