import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { GanttChart } from "@/components/gantt/GanttChart";
import { seedPhaseTemplateIfEmpty } from "@/lib/phase-seed";
import { portalUrlFor } from "@/lib/portal-link";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, VisitContactSummary } from "@/lib/trade-visits";
import type { GanttTimelineMarker } from "@/types/board-cockpit";

const UMBRELLA_SECTION_NAME_MATCH = "preliminaries & site";

/**
 * /projects/[id]/timeline — Timeline tab (BUILD-SPEC.md "Gantt" / Phase
 * 11A "Timeline v2" / Fix Round A "phase unification" + "pre-populated
 * phases" + "Site Setup umbrella span fix"). Team-visible, not
 * admin-gated (scheduling data, no pricing). Follows the same
 * direct-Supabase-query convention as the Board page (see that page's
 * doc comment) rather than internally fetching its own API route — so
 * the shared-seed-path + cost-section-binding-refresh logic is
 * replicated here in full (same as GET /api/projects/[id]/phases; see
 * that route's doc comment for the full design rationale, including
 * THE INVARIANT for phase<->board-group unification) rather than the
 * page calling its own API route, which would be an unusual self-fetch
 * for a Server Component in this codebase.
 *
 * FIX ROUND A changes from the original Phase 11A version of this
 * page:
 *   1. Seeds the phase template (shared seed path — this is one of the
 *      two "first visit" surfaces alongside the Board's Grouped-list
 *      view) if the project has zero phases yet, via
 *      lib/phase-seed.ts's seedPhaseTemplateIfEmpty() — the SAME
 *      function GET /api/projects/[id]/phases and POST
 *      /api/projects/[id]/board/groups/seed both call, so all three
 *      "first visit" entry points can never seed a different
 *      template.
 *   2. REMOVED the umbrella recompute-to-min/max-of-ordinary-phases
 *      logic entirely (Site Setup umbrella span fix, BUILD-SPEC.md
 *      item 3) — the umbrella phase's dates are now ordinary,
 *      user-editable data set once at seed time, never silently
 *      overwritten on page load.
 *   3. Still refreshes the umbrella's cost_section_id binding (link
 *      only, not dates) to "Preliminaries & Site" on every load, same
 *      as the API route.
 */
export default async function ProjectTimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info] = await Promise.all([
    supabase.from("projects").select("id, name, client_name, client_token").eq("id", id).single(),
    getUserRole(supabase),
  ]);

  if (!project) {
    notFound();
  }
  const isAdmin = info?.role === "admin";

  await seedPhaseTemplateIfEmpty(supabase, id);

  // ---- Cost-section binding refresh (link only — see doc comment
  // above and GET /api/projects/[id]/phases's identical logic) ----
  const { data: sections } = await supabase.from("cost_sections").select("id,name").eq("project_id", id);
  const prelimSection = (sections ?? []).find((s) => s.name.trim().toLowerCase() === UMBRELLA_SECTION_NAME_MATCH);

  let sectionHasLines = false;
  if (prelimSection) {
    const { count } = await supabase
      .from("cost_lines")
      .select("id", { count: "exact", head: true })
      .eq("section_id", prelimSection.id)
      .is("deleted_at", null);
    sectionHasLines = (count ?? 0) > 0;
  }

  const { data: existingUmbrella } = await supabase
    .from("schedule_phases")
    .select("id,cost_section_id")
    .eq("project_id", id)
    .eq("kind", "umbrella")
    .is("deleted_at", null)
    .maybeSingle();

  if (existingUmbrella) {
    const nextSectionId = prelimSection && sectionHasLines ? prelimSection.id : null;
    if (existingUmbrella.cost_section_id !== nextSectionId) {
      await supabase.from("schedule_phases").update({ cost_section_id: nextSectionId }).eq("id", existingUmbrella.id);
    }
  }

  // ---- Main query ----
  const { data: phases } = await supabase
    .from("schedule_phases")
    .select("*")
    .eq("project_id", id)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  type PhaseRow = Omit<SchedulePhaseWithVisits, "contact" | "visits" | "cost_section_lines">;
  const phaseRows = (phases ?? []) as PhaseRow[];

  const contactIds = [...new Set(phaseRows.map((p) => p.contact_id).filter(Boolean))] as string[];
  const { data: contacts } = contactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
    : { data: [] as VisitContactSummary[] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const phaseIds = phaseRows.map((p) => p.id);
  const { data: visits } = phaseIds.length
    ? await supabase
        .from("trade_visits")
        .select("*")
        .in("phase_id", phaseIds)
        .is("deleted_at", null)
        .order("start_date", { ascending: true })
    : { data: [] as (TradeVisitWithContact & { contact_id: string | null })[] };

  const visitContactIds = [...new Set((visits ?? []).map((v) => v.contact_id).filter(Boolean))] as string[];
  const { data: visitContacts } = visitContactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", visitContactIds)
    : { data: [] as VisitContactSummary[] };
  const visitContactById = new Map((visitContacts ?? []).map((c) => [c.id, c]));

  const visitsByPhase = new Map<string, TradeVisitWithContact[]>();
  for (const v of visits ?? []) {
    const list = visitsByPhase.get(v.phase_id) ?? [];
    list.push({ ...v, contact: v.contact_id ? visitContactById.get(v.contact_id) ?? null : null });
    visitsByPhase.set(v.phase_id, list);
  }

  let costSectionLines: string[] = [];
  const umbrellaRow = phaseRows.find((p) => p.kind === "umbrella");
  if (umbrellaRow?.cost_section_id) {
    const { data: lines } = await supabase
      .from("cost_lines")
      .select("description")
      .eq("section_id", umbrellaRow.cost_section_id)
      .is("deleted_at", null)
      .order("sort", { ascending: true });
    costSectionLines = (lines ?? []).map((l) => l.description);
  }

  const initialPhases: SchedulePhaseWithVisits[] = phaseRows.map((p) => ({
    ...p,
    contact: p.contact_id ? contactById.get(p.contact_id) ?? null : null,
    visits: visitsByPhase.get(p.id) ?? [],
    ...(p.kind === "umbrella" ? { cost_section_lines: costSectionLines } : {}),
  }));

  // Board cockpit round — Gantt tick markers: board_tasks due_date/
  // booking_date + milestone diamonds. Joined via board_groups.phase_id
  // (a board_tasks row carries phase_group_id -> board_groups, not
  // schedule_phases directly — see Round A's phase-unification
  // invariant, migration 023) so a marker lands in the correct phase
  // row. This is read-only rendering data, computed once here
  // server-side — GanttChart.tsx's drag math (lib/phase-drag.ts) never
  // sees or touches these rows.
  const { data: groupsForMarkers } = await supabase
    .from("board_groups")
    .select("id,phase_id")
    .eq("project_id", id)
    .not("phase_id", "is", null);
  const phaseIdByGroupId = new Map((groupsForMarkers ?? []).map((g) => [g.id, g.phase_id as string]));
  const groupIds = [...phaseIdByGroupId.keys()];

  // Timeline Day-zoom polish round — item 5 "Better board linking":
  // reverse the phase_id -> group_id map above (already fetched for
  // the tick-marker join, so this is additive/zero extra queries) to
  // annotate each phase with its linked board_groups id, mirroring what
  // GET /api/projects/[id]/phases already returns via
  // types/phase-fix-a.ts's SchedulePhaseWithBoardGroup (that route's
  // own response shape is untouched — this page has always built its
  // own equivalent query rather than calling that route, per this
  // file's header doc comment, so it needs its own equivalent join).
  // GanttChart.tsx reads this via its local PhaseWithGroupLink
  // intersection type — SchedulePhaseWithVisits itself (lib/trade-visits.ts)
  // is untouched.
  const groupIdByPhaseId = new Map(
    [...phaseIdByGroupId.entries()].map(([groupId, phaseId]) => [phaseId, groupId])
  );
  const initialPhasesWithGroupLink = initialPhases.map((p) => ({
    ...p,
    board_group_id: groupIdByPhaseId.get(p.id) ?? null,
  }));

  const { data: markerTasks } = groupIds.length
    ? await supabase
        .from("board_tasks")
        .select("id,title,kind,due_date,booking_date,phase_group_id")
        .in("phase_group_id", groupIds)
        .is("deleted_at", null)
    : { data: [] as { id: string; title: string; kind: string; due_date: string | null; booking_date: string | null; phase_group_id: string | null }[] };

  const timelineMarkers: GanttTimelineMarker[] = [];
  // Board v3.1 — display-first cells, item 8's Timeline-side rollup
  // gating: a phase whose linked board_groups row has ANY task with a
  // booking_date set has its Timeline dates DERIVED from those tasks
  // (see lib/phase-rollup.ts's rollupPhaseDatesForGroup, called
  // server-side by every board_tasks write path) — GanttChart's
  // PhaseEditPanel should disable its own start/end inputs for exactly
  // these phases rather than let a manual Timeline edit immediately be
  // clobbered by the next rollup. Reuses `markerTasks` (already fetched
  // above for the tick-marker join, zero extra queries) rather than a
  // second query.
  const worksDatesLockedPhaseIdSet = new Set<string>();
  for (const t of markerTasks ?? []) {
    const phase_id = t.phase_group_id ? phaseIdByGroupId.get(t.phase_group_id) ?? null : null;
    if (t.kind === "milestone" && t.due_date) {
      timelineMarkers.push({ task_id: t.id, title: t.title, kind: "milestone", date: t.due_date, phase_id });
    } else if (t.due_date) {
      timelineMarkers.push({ task_id: t.id, title: t.title, kind: "due_date", date: t.due_date, phase_id });
    }
    if (t.booking_date) {
      timelineMarkers.push({ task_id: t.id, title: t.title, kind: "booking_date", date: t.booking_date, phase_id });
      if (phase_id) worksDatesLockedPhaseIdSet.add(phase_id);
    }
  }
  const worksDatesLockedPhaseIds = [...worksDatesLockedPhaseIdSet];

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Timeline`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="timeline" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <GanttChart
          projectId={id}
          initialPhases={initialPhasesWithGroupLink}
          timelineMarkers={timelineMarkers}
          worksDatesLockedPhaseIds={worksDatesLockedPhaseIds}
        />
      </main>
    </>
  );
}
