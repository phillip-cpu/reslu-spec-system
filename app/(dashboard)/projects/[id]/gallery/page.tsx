import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { GalleryWorkspace } from "@/components/gallery/GalleryWorkspace";

/**
 * /projects/[id]/gallery — internal site-photo staging gallery
 * (BUILD-SPEC.md §"Phase 11 addition — site photo gallery" +
 * §"mobile pass": "Internal Gallery tab on the project: mobile-first
 * upload (input capture='environment' so phones open the camera
 * directly on site), multi-select upload, grid by date, captions
 * inline.").
 *
 * Team access (not admin-only) — same trust tier as Documents/Board/
 * Timeline: nothing here is financial. Linked from ProjectTabs via the
 * minimal single-line diff added to that shared file (see this task's
 * final report — components/projects/ProjectTabs.tsx is not otherwise
 * in this agent's boundary and is worked on concurrently by the Phase
 * 11A agent).
 */
export default async function ProjectGalleryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Site gallery`} subtitleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="gallery" isAdmin={info?.role === "admin"} />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <GalleryWorkspace projectId={id} />
      </main>
    </>
  );
}
