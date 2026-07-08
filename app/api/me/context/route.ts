import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { daysSince } from "@/lib/leads";

export const runtime = "nodejs";

const RECENT_DIARY_LIMIT = 5;
const DIARY_LOOKBACK = 300; // capped fetch for per-project "most recent" grouping — see comment below.
const ONE_LINE_LENGTH = 100;

function oneLine(text: string | null, fallback: string): string {
  if (!text) return fallback;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > ONE_LINE_LENGTH ? `${flat.slice(0, ONE_LINE_LENGTH - 1)}…` : flat;
}

/**
 * GET /api/me/context
 * GET /api/me/context?project_id=<uuid>
 *
 * RESLU Second Brain, Step 7 (docs/RESLU-second-brain-build-brief.md).
 * Compact snapshot replacing 6-8 separate MCP round-trips — IDs,
 * names, counts, one-liners only, per the brief's own rule. No full
 * records: Aria pulls detail via the Step 6 `search` tool or existing
 * per-record tools when she needs more than this gives her.
 *
 * Two fields in the brief's documented shape can't be populated yet
 * and are deliberately left empty rather than omitted (so the
 * response shape stays stable for whatever calls this once they DO
 * exist):
 *   - open_proposals: change_proposals doesn't exist until Step 11
 *     (the email pipeline's proposal/approval table). Always 0 here.
 *   - skills / recent_emails: filesystem-based (Aria's Mac-mini
 *     skills) or not-yet-built (Step 8's emails table) — this route
 *     runs on Vercel with zero access to the Mac-mini filesystem, so
 *     "skills"/"memory_refs" are always [] regardless of Step 8's
 *     status; recent_emails similarly [] until Step 8 ships.
 *
 * No SQL aggregation function written for item_count/last_diary/
 * overdue-booking flags — at this app's actual data scale (a handful
 * of projects, low hundreds of items total) a plain fetch + in-memory
 * grouping is simpler and fast enough, matching the same choice made
 * throughout Step 5's indexer and cleanup pass.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = request.nextUrl.searchParams.get("project_id");
  const generatedAt = new Date().toISOString();

  if (projectId) {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id,name,status")
      .eq("id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    if (projectError) return NextResponse.json({ error: projectError.message }, { status: 500 });
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const { data: items, error: itemsError } = await supabase
      .from("items")
      .select("id,item_code,name,status,price_rrp,price_trade,lead_time_weeks")
      .eq("project_id", projectId)
      .is("deleted_at", null);
    if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });

    return NextResponse.json({
      project: {
        ...project,
        items: items ?? [],
        open_proposals: 0, // placeholder — change_proposals doesn't exist until Step 11.
        recent_emails: [], // placeholder — emails doesn't exist until Step 8.
      },
      generated_at: generatedAt,
    });
  }

  const [{ data: projects, error: projectsError }, { data: leads, error: leadsError }, { data: queueRows, error: queueError }] =
    await Promise.all([
      supabase.from("projects").select("id,name,status").eq("status", "active").is("deleted_at", null),
      supabase
        .from("leads")
        .select("id,first_name,surname_project,stage,received_at")
        .is("deleted_at", null)
        .not("stage", "in", "(Lead Lost,Complete)"),
      supabase.from("aria_queue").select("kind").eq("status", "pending"),
    ]);
  if (projectsError) return NextResponse.json({ error: projectsError.message }, { status: 500 });
  if (leadsError) return NextResponse.json({ error: leadsError.message }, { status: 500 });
  if (queueError) return NextResponse.json({ error: queueError.message }, { status: 500 });

  const projectIds = (projects ?? []).map((p) => p.id);

  const [{ data: items, error: itemsError }, { data: visits, error: visitsError }, { data: diary, error: diaryError }] =
    await Promise.all([
      projectIds.length
        ? supabase.from("items").select("project_id").in("project_id", projectIds).is("deleted_at", null)
        : Promise.resolve({ data: [] as { project_id: string }[], error: null }),
      projectIds.length
        ? supabase
            .from("trade_visits")
            .select("project_id,status,start_date")
            .in("project_id", projectIds)
            .is("deleted_at", null)
            .in("status", ["unconfirmed", "tentative"])
        : Promise.resolve({ data: [] as { project_id: string; status: string; start_date: string }[], error: null }),
      supabase
        .from("portal_updates")
        .select("project_id,title,body_richtext,created_at")
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .limit(DIARY_LOOKBACK),
    ]);
  if (itemsError) return NextResponse.json({ error: itemsError.message }, { status: 500 });
  if (visitsError) return NextResponse.json({ error: visitsError.message }, { status: 500 });
  if (diaryError) return NextResponse.json({ error: diaryError.message }, { status: 500 });

  const itemCountByProject = new Map<string, number>();
  for (const item of items ?? []) {
    itemCountByProject.set(item.project_id, (itemCountByProject.get(item.project_id) ?? 0) + 1);
  }

  const today = new Date().toISOString().slice(0, 10);
  const overdueBookingProjects = new Set(
    (visits ?? []).filter((v) => v.start_date < today).map((v) => v.project_id)
  );

  const lastDiaryByProject = new Map<string, { title: string | null; body_richtext: string | null }>();
  for (const entry of diary ?? []) {
    if (!lastDiaryByProject.has(entry.project_id)) {
      lastDiaryByProject.set(entry.project_id, entry);
    }
  }

  const projectSnapshots = (projects ?? []).map((p) => {
    const flags: string[] = [];
    if (overdueBookingProjects.has(p.id)) flags.push("overdue_booking");
    const lastDiary = lastDiaryByProject.get(p.id);
    return {
      id: p.id,
      name: p.name,
      stage: p.status, // projects have no `stage` column — `status` is the closest equivalent (pipeline stage lives on leads.stage).
      flags,
      item_count: itemCountByProject.get(p.id) ?? 0,
      open_proposals: 0, // placeholder — change_proposals doesn't exist until Step 11.
      last_diary: lastDiary ? oneLine(lastDiary.title ?? lastDiary.body_richtext, "(no updates yet)") : "(no updates yet)",
    };
  });

  const leadSnapshots = (leads ?? []).map((l) => ({
    id: l.id,
    name: [l.first_name, l.surname_project].filter(Boolean).join(" ") || "(unnamed lead)",
    stage: l.stage,
    // No dedicated "last contact" column exists on leads — received_at
    // (when the lead first came in) is the closest available proxy,
    // not literally "days since we last spoke to them".
    days_since_contact: daysSince(l.received_at),
  }));

  const queueKinds: Record<string, number> = {};
  for (const row of queueRows ?? []) {
    queueKinds[row.kind] = (queueKinds[row.kind] ?? 0) + 1;
  }

  const recentDiary = (diary ?? [])
    .slice(0, RECENT_DIARY_LIMIT)
    .map((d) => oneLine(d.title ?? d.body_richtext, "(untitled update)"));

  return NextResponse.json({
    projects: projectSnapshots,
    leads: leadSnapshots,
    pending_queue: { count: queueRows?.length ?? 0, kinds: queueKinds },
    recent_diary: recentDiary,
    skills: [], // filesystem-based (Aria's Mac mini) — unreachable from this Vercel route.
    memory_refs: [], // same as skills.
    generated_at: generatedAt,
  });
}
