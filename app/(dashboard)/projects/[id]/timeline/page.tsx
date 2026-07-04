import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { GanttChart } from "@/components/gantt/GanttChart";
import type { SchedulePhaseWithContact } from "@/types";

/**
 * /projects/[id]/timeline — Week 9 Gantt tab (BUILD-SPEC.md "Gantt").
 * Team-visible, not admin-gated (scheduling data, no pricing). Follows
 * the same direct-Supabase-query convention as the Board page (see
 * that page's doc comment) rather than internally fetching its own API
 * route.
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

  const { data: phases } = await supabase
    .from("schedule_phases")
    .select("*")
    .eq("project_id", id)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  const contactIds = [...new Set((phases ?? []).map((p) => p.contact_id).filter(Boolean))] as string[];
  const { data: contacts } = contactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
    : { data: [] as { id: string; company: string; contact_name: string | null }[] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const initialPhases: SchedulePhaseWithContact[] = (phases ?? []).map((p) => ({
    ...p,
    contact: p.contact_id ? contactById.get(p.contact_id) ?? null : null,
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
