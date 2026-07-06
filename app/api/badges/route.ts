import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { bucketFor } from "@/lib/my-work";

export const runtime = "nodejs";

/**
 * GET /api/badges
 * Fix round B — BUILD-SPEC.md §"Sidebar notification badges": "Sidebar
 * entries gain count badges (small red pill, right-aligned): Leads =
 * follow-ups due count (admin only); My Work = my items due today +
 * overdue. Lightweight GET /api/badges endpoint returning both counts
 * in one call; sidebar polls every ~3 min + refreshes on navigation."
 *
 * Deliberately NOT a call into GET /api/my-work's full aggregator: that
 * route fans out 6 source queries PLUS join lookups (projects, board
 * columns, contacts) to build full display rows (title/href/project
 * name/meta) for the My Work page itself. A sidebar badge only needs a
 * COUNT, polled every ~3 minutes from every signed-in user's browser —
 * running the full aggregator (with its joins) that often would be the
 * opposite of "lightweight". Instead, this route re-queries the same
 * six MyWorkItem source tables but selects ONLY the `due_date`-shaped
 * column each needs (no joins, no title/project lookups), and buckets
 * every date through the exact same `bucketFor()` helper
 * (lib/my-work.ts) GET /api/my-work uses — so "today + overdue" can
 * never silently drift from what the My Work page itself would count,
 * even though the two routes' queries look different.
 *
 * leads_followups: admin-only (0 for non-admins, matching GET
 * /api/leads/attention's own admin gate and lib/leads.ts's
 * isFollowUpDue — a due-or-past follow_up_date) — pushed down to a
 * `head: true` COUNT query (no rows fetched at all) rather than
 * lib/leads.ts's computeAttentionGroups, which needs full Lead rows +
 * lead_stage_events for its OTHER three groups (nurture/stale/site
 * visits) this badge doesn't need.
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { userId, role } = info;
  const isAdmin = role === "admin";

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // ---- leads_followups (admin only) ----
  let leadsFollowups = 0;
  if (isAdmin) {
    const { count } = await supabase
      .from("leads")
      .select("id", { count: "exact", head: true })
      .is("deleted_at", null)
      .not("follow_up_date", "is", null)
      .lte("follow_up_date", todayStr);
    leadsFollowups = count ?? 0;
  }

  // ---- my_work_due (today + overdue, across the same six MyWorkItem
  // sources GET /api/my-work aggregates, bucketed via the shared
  // bucketFor() helper) ----
  let myWorkDue = 0;

  // 1. Board tasks assigned to me.
  const { data: myAssignments } = await supabase
    .from("board_task_assignees")
    .select("task_id")
    .eq("profile_id", userId);
  const myTaskIds = (myAssignments ?? []).map((a) => a.task_id);
  if (myTaskIds.length > 0) {
    const { data: tasks } = await supabase
      .from("board_tasks")
      .select("due_date")
      .in("id", myTaskIds)
      .is("deleted_at", null);
    for (const t of tasks ?? []) {
      const bucket = bucketFor(t.due_date, today);
      if (bucket === "today" || bucket === "overdue") myWorkDue += 1;
    }
  }

  // 2. Lead follow-ups (admin only — same admin gate as GET /api/my-work source #2).
  if (isAdmin) {
    const { data: leads } = await supabase
      .from("leads")
      .select("follow_up_date")
      .is("deleted_at", null)
      .lte("follow_up_date", todayStr)
      .not("follow_up_date", "is", null);
    for (const l of leads ?? []) {
      const bucket = bucketFor(l.follow_up_date, today);
      if (bucket === "today" || bucket === "overdue") myWorkDue += 1;
    }
  }

  // 3. Diary drafts pending approval (bucketed on updated_at, same stand-in as GET /api/my-work).
  const { data: drafts } = await supabase
    .from("portal_updates")
    .select("updated_at")
    .eq("status", "pending_approval")
    .is("deleted_at", null);
  for (const d of drafts ?? []) {
    const due = d.updated_at ? d.updated_at.slice(0, 10) : null;
    const bucket = bucketFor(due, today);
    if (bucket === "today" || bucket === "overdue") myWorkDue += 1;
  }

  // 4. Trade-visit proposals awaiting response.
  const { data: proposals } = await supabase
    .from("trade_visits")
    .select("proposed_start,updated_at")
    .eq("status", "proposed_change")
    .is("deleted_at", null);
  for (const p of proposals ?? []) {
    const due = p.proposed_start ?? (p.updated_at ? p.updated_at.slice(0, 10) : null);
    const bucket = bucketFor(due, today);
    if (bucket === "today" || bucket === "overdue") myWorkDue += 1;
  }

  // 5. Overdue client decisions (decision_needed_by past, still undecided).
  const { count: overdueDecisionCount } = await supabase
    .from("items")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .not("decision_needed_by", "is", null)
    .lt("decision_needed_by", todayStr)
    .eq("client_approved", false)
    .eq("client_flagged", false);
  // Every row this query matches is by definition in the past relative
  // to todayStr, so each one buckets to "overdue" — no need to fetch
  // rows just to run them through bucketFor().
  myWorkDue += overdueDecisionCount ?? 0;

  // 6. Office board tasks assigned to me (Phase 13), excluding standing
  // rule cards and already-completed tasks.
  const { data: myOfficeAssignments } = await supabase
    .from("office_task_assignees")
    .select("task_id")
    .eq("profile_id", userId);
  const myOfficeTaskIds = (myOfficeAssignments ?? []).map((a) => a.task_id);
  if (myOfficeTaskIds.length > 0) {
    const { data: officeTasks } = await supabase
      .from("office_tasks")
      .select("due_date")
      .in("id", myOfficeTaskIds)
      .is("deleted_at", null)
      .eq("kind", "task")
      .is("completed_at", null);
    for (const t of officeTasks ?? []) {
      const bucket = bucketFor(t.due_date, today);
      if (bucket === "today" || bucket === "overdue") myWorkDue += 1;
    }
  }

  return NextResponse.json({
    leads_followups: leadsFollowups,
    my_work_due: myWorkDue,
  });
}
