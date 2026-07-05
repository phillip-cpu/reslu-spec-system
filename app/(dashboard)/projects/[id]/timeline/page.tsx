import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { GanttChart } from "@/components/gantt/GanttChart";
import { computeUmbrellaBand } from "@/lib/trade-visits";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, VisitContactSummary } from "@/lib/trade-visits";

const UMBRELLA_NAME = "Site Setup";
const UMBRELLA_SECTION_NAME_MATCH = "preliminaries & site";
const SORT_STEP = 1000;

/**
 * /projects/[id]/timeline — Timeline tab (BUILD-SPEC.md "Gantt" / Phase
 * 11A "Timeline v2"). Team-visible, not admin-gated (scheduling data,
 * no pricing). Follows the same direct-Supabase-query convention as
 * the Board page (see that page's doc comment) rather than internally
 * fetching its own API route — so the umbrella recompute-on-read logic
 * is replicated here in full (same as GET /api/projects/[id]/phases;
 * see that route's doc comment for the full design rationale) rather
 * than the page calling its own API route, which would be an unusual
 * self-fetch for a Server Component in this codebase.
 */
export default async function ProjectTimelinePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info] = await Promise.all([
    supabase.from("projects").select("id, name, client_name").eq("id", id).single(),
    getUserRole(supabase),
  ]);

  if (!project) {
    notFound();
  }
  const isAdmin = info?.role === "admin";

  // ---- Umbrella recompute-on-read (identical logic to
  // GET /api/projects/[id]/phases — see that route's doc comment) ----
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
    .select("id,start_date,end_date")
    .eq("project_id", id)
    .eq("kind", "umbrella")
    .is("deleted_at", null)
    .maybeSingle();

  if (prelimSection && sectionHasLines) {
    const { data: ordinaryPhases } = await supabase
      .from("schedule_phases")
      .select("kind,start_date,end_date")
      .eq("project_id", id)
      .eq("kind", "phase")
      .is("deleted_at", null);

    const band = computeUmbrellaBand(
      (ordinaryPhases ?? []).map((p) => ({ kind: "phase" as const, start_date: p.start_date, end_date: p.end_date }))
    );

    if (band) {
      if (existingUmbrella) {
        if (existingUmbrella.start_date !== band.start_date || existingUmbrella.end_date !== band.end_date) {
          await supabase
            .from("schedule_phases")
            .update({ start_date: band.start_date, end_date: band.end_date, cost_section_id: prelimSection.id })
            .eq("id", existingUmbrella.id);
        }
      } else {
        await supabase.from("schedule_phases").insert({
          project_id: id,
          name: UMBRELLA_NAME,
          start_date: band.start_date,
          end_date: band.end_date,
          color_key: "charcoal",
          kind: "umbrella",
          cost_section_id: prelimSection.id,
          sort: -SORT_STEP,
        });
      }
    }
  } else if (existingUmbrella) {
    await supabase
      .from("schedule_phases")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", existingUmbrella.id);
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

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Timeline`} />
      <ProjectTabs projectId={id} active="timeline" isAdmin={isAdmin} />
      <main className="flex-1 px-8 py-8">
        <GanttChart projectId={id} initialPhases={initialPhases} />
      </main>
    </>
  );
}
