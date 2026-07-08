import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import vercelConfig from "../../../../vercel.json";

export const runtime = "nodejs";

const MAX_TOTAL_DOTS = 1500;
const RECENT_DAYS = 90;

type BrainRecord = { id: string; name: string; flagged: boolean; recentAt: string; recordUrl: string | null };
type BrainCluster = { entityType: string; label: string; totalCount: number; records: BrainRecord[] };

function isRecent(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const cutoff = Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000;
  return new Date(dateStr).getTime() >= cutoff;
}

/** Rough, human-readable cron cadence — decorative text for the visualizer, not a precise translation. */
function describeCron(schedule: string): string {
  if (/^\*\/(\d+) \* \* \* \*$/.test(schedule)) return `every ${schedule.split("/")[1].split(" ")[0]} min`;
  if (/\/15 \* \* \* \*$/.test(schedule)) return "every 15 min";
  if (/^\d+ \d+(,\d+)* \* \* \*$/.test(schedule)) return "several times daily";
  if (/^\d+ \d+ \* \* \*$/.test(schedule)) return "daily";
  return schedule;
}

/**
 * GET /api/second-brain/brain-data
 *
 * RESLU Second Brain, Step 13 (docs/RESLU-second-brain-build-brief.md).
 * Serves the /brain visualizer's live data — real per-entity-type
 * counts (workspace_index scope: project/lead/item/diary/sow, plus
 * emails read directly from the emails table since Step 5 never
 * indexed those into workspace_index) and the real cron schedule
 * (imported from vercel.json, bundled at build time — reading it via
 * fs at request time isn't a reliable pattern on Vercel's serverless
 * runtime for an arbitrary repo file).
 *
 * Aggregation rule (the brief's own, not a judgment call): only
 * flagged (open change_proposals) or recently-touched (last 90 days)
 * records get an individual dot; everything else exists only in
 * totalCount. Capped at 1,500 dots total across every cluster
 * combined — at this app's actual data scale that cap is not expected
 * to bind in practice, but the code enforces it regardless.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ count: itemCount }, { count: projectCount }, { count: leadCount }, { count: diaryCount }, { count: sowCount }, { count: emailCount }] =
    await Promise.all([
      supabase.from("items").select("id", { count: "exact", head: true }).is("deleted_at", null),
      supabase.from("projects").select("id", { count: "exact", head: true }).is("deleted_at", null),
      supabase.from("leads").select("id", { count: "exact", head: true }).is("deleted_at", null),
      supabase.from("portal_updates").select("id", { count: "exact", head: true }).is("deleted_at", null),
      supabase.from("sow_documents").select("id", { count: "exact", head: true }).is("deleted_at", null),
      supabase.from("emails").select("id", { count: "exact", head: true }),
    ]);

  const { data: openProposals } = await supabase.from("change_proposals").select("entity_id").eq("status", "pending");
  const flaggedItemIds = new Set((openProposals ?? []).map((p) => p.entity_id));

  const [{ data: items }, { data: projects }, { data: leads }, { data: diary }, { data: sow }, { data: emails }] = await Promise.all([
    supabase.from("items").select("id,name,project_id,updated_at").is("deleted_at", null),
    supabase.from("projects").select("id,name,updated_at").is("deleted_at", null),
    supabase.from("leads").select("id,first_name,surname_project,updated_at").is("deleted_at", null),
    supabase.from("portal_updates").select("id,title,project_id,created_at").is("deleted_at", null),
    supabase.from("sow_documents").select("id,revision_label,project_id,created_at").is("deleted_at", null),
    supabase.from("emails").select("id,subject,received_at,status").order("received_at", { ascending: false }).limit(500),
  ]);

  const itemRecords: BrainRecord[] = (items ?? [])
    .filter((i) => flaggedItemIds.has(i.id) || isRecent(i.updated_at))
    .map((i) => ({
      id: i.id,
      name: i.name,
      flagged: flaggedItemIds.has(i.id),
      recentAt: i.updated_at,
      recordUrl: `/projects/${i.project_id}#focus-ordering_due-${i.id}`,
    }));

  const projectRecords: BrainRecord[] = (projects ?? [])
    .filter((p) => isRecent(p.updated_at))
    .map((p) => ({ id: p.id, name: p.name, flagged: false, recentAt: p.updated_at, recordUrl: `/projects/${p.id}` }));

  const leadRecords: BrainRecord[] = (leads ?? [])
    .filter((l) => isRecent(l.updated_at))
    .map((l) => ({
      id: l.id,
      name: [l.first_name, l.surname_project].filter(Boolean).join(" ") || "(unnamed lead)",
      flagged: false,
      recentAt: l.updated_at,
      recordUrl: `/leads`,
    }));

  const diarySowRecords: BrainRecord[] = [
    ...(diary ?? [])
      .filter((d) => isRecent(d.created_at))
      .map((d) => ({ id: d.id, name: d.title ?? "(untitled update)", flagged: false, recentAt: d.created_at, recordUrl: `/projects/${d.project_id}` })),
    ...(sow ?? [])
      .filter((s) => isRecent(s.created_at))
      .map((s) => ({
        id: s.id,
        name: `SOW ${s.revision_label ?? ""}`.trim(),
        flagged: false,
        recentAt: s.created_at,
        recordUrl: `/projects/${s.project_id}/sow`,
      })),
  ];

  const emailRecords: BrainRecord[] = (emails ?? [])
    .filter((e) => isRecent(e.received_at))
    .map((e) => ({ id: e.id, name: e.subject ?? "(no subject)", flagged: false, recentAt: e.received_at, recordUrl: null }));

  const rawClusters: BrainCluster[] = [
    { entityType: "email", label: "EMAILS", totalCount: emailCount ?? 0, records: emailRecords },
    { entityType: "item", label: "ITEMS", totalCount: itemCount ?? 0, records: itemRecords },
    { entityType: "project", label: "JOBS", totalCount: projectCount ?? 0, records: projectRecords },
    { entityType: "diary_sow", label: "DIARY + SOW", totalCount: (diaryCount ?? 0) + (sowCount ?? 0), records: diarySowRecords },
    { entityType: "lead", label: "LEADS", totalCount: leadCount ?? 0, records: leadRecords },
  ];

  // Global 1,500-dot cap across every cluster combined — flagged
  // records take priority over recent-only when trimming is needed.
  let totalDots = rawClusters.reduce((sum, c) => sum + c.records.length, 0);
  if (totalDots > MAX_TOTAL_DOTS) {
    let overflow = totalDots - MAX_TOTAL_DOTS;
    for (const cluster of rawClusters) {
      if (overflow <= 0) break;
      cluster.records.sort((a, b) => Number(b.flagged) - Number(a.flagged));
      const trimmable = cluster.records.length - cluster.records.filter((r) => r.flagged).length;
      const trimCount = Math.min(trimmable, overflow);
      if (trimCount > 0) {
        cluster.records.splice(cluster.records.length - trimCount, trimCount);
        overflow -= trimCount;
      }
    }
    totalDots = rawClusters.reduce((sum, c) => sum + c.records.length, 0);
  }

  const routines = (vercelConfig.crons ?? []).map((c: { path: string; schedule: string }) => {
    const name = c.path.split("/").filter(Boolean).pop() ?? c.path;
    return `${name} · ${describeCron(c.schedule)}`;
  });

  return NextResponse.json({ clusters: rawClusters, routines, totalDots });
}
