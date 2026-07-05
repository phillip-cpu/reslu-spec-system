import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { groupMyWorkItems } from "@/lib/my-work";
import type { MyWorkItem, MyWorkResponse } from "@/types/phase-12a-b";

export const runtime = "nodejs";

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
 *
 * None of these six sources require a project-membership check (this
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
      .select("id,project_id,column_id,title,due_date")
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
        title: t.title,
        project: project ? { id: project.id, name: project.name, alias: project.alias } : null,
        due: t.due_date,
        href: `/projects/${t.project_id}/board`,
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
        href: `/projects/${d.project_id}/client?tab=diary`,
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
        href: `/projects/${p.project_id}/timeline`,
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
        href: `/projects/${i.project_id}?tab=ffe`,
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
      .select("id,group_id,title,due_date,kind,completed_at")
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
        href: "/office",
        meta: groupById.get(t.group_id)?.name ?? "Office",
      });
    }
  }

  const groups = groupMyWorkItems(items);
  const body: MyWorkResponse = { groups, is_admin: isAdmin };
  return NextResponse.json(body);
}
