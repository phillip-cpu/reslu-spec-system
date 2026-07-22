import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { carriedOverLabel } from "@/lib/daily-brief";
import type { BriefResponse, DailyBriefItem, DailyBriefItemWithMeta } from "@/types/round-daily-brief";

export const runtime = "nodejs";

/**
 * GET /api/brief
 * Returns every OPEN item regardless of brief_date. Completed items
 * remain stored for audit/deduplication but are deliberately omitted
 * from My Work so ticking a row clears it from the active view.
 * Carried-over open items keep their "from yesterday"/weekday label.
 *
 * Admin-gated (this round's own "brief admin-gating consistent"
 * verification note): the brief mixes admin-only-sourced rows (leads
 * nurture/stale, ordering_due) with team-visible ones (bookings,
 * trade proposals, insurance) into ONE shared single-team feed
 * (v1 — no per-user brief yet, see migration 041's user_id doc
 * comment) that cannot be split per-role without either exposing
 * admin-only titles/links to non-admins or maintaining two divergent
 * brief views. Gating the WHOLE brief (panel + every /api/brief*
 * route) to admin-only in v1 is the simplest rule that can't leak
 * admin-only data — same "if (isAdmin)" precedent GET /api/my-work's
 * own lead_follow_up/ordering_due sources already established, just
 * applied to the whole feed rather than per-source. Documented here,
 * in this round's docs/API.md, and in the final report.
 * components/my-work/DailyBrief.tsx self-gates by treating a 403 here
 * as "render nothing" rather than needing a separate is_admin prop
 * threaded through MyWorkWorkspace.
 */
export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "The Daily Brief is admin-only in v1." }, { status: 403 });
  }

  const { data: openRows, error: openError } = await supabase
    .from("daily_brief_items")
    .select("*")
    .eq("status", "open")
    .order("brief_date", { ascending: true })
    .order("created_at", { ascending: true });

  if (openError) {
    return NextResponse.json({ error: openError.message }, { status: 500 });
  }
  const rows = (openRows ?? []) as DailyBriefItem[];

  const projectIds = [...new Set(rows.map((r) => r.project_id).filter((id): id is string => !!id))];
  const { data: projects } = projectIds.length
    ? await supabase.from("projects").select("id,name,alias").in("id", projectIds)
    : { data: [] as { id: string; name: string; alias: string | null }[] };
  const projectById = new Map((projects ?? []).map((p) => [p.id, p]));

  const items: DailyBriefItemWithMeta[] = rows.map((r) => {
    const project = r.project_id ? projectById.get(r.project_id) ?? null : null;
    // "added to {project}" (board-task conversion) / "added to Office"
    // (office-task conversion, converted_office_task_id) — see
    // migration 041's own "SECOND DEVIATION NOTE" for why these are
    // two separate FK columns, and daily_brief_items' own comment for
    // why this label is computed here rather than stored.
    const convertedLabel = r.converted_task_id
      ? `added to ${project?.name ?? "project"}`
      : r.converted_office_task_id
        ? "added to Office"
        : null;
    return {
      ...r,
      project,
      carried_over_label: carriedOverLabel(r.brief_date),
      converted_label: convertedLabel,
    };
  });

  const body: BriefResponse = {
    items,
    refreshed_at: new Date().toISOString(),
    done_count: 0,
    total_count: items.length,
  };
  return NextResponse.json(body);
}
