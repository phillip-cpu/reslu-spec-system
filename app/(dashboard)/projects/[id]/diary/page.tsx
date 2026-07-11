import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { SiteDiary } from "@/components/site-diary/SiteDiary";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/diary — "Site diary" (Site capture + mobile QoL
 * round, r21, BUILD-SPEC.md item 4): "project page gains 'Site diary'
 * — reverse-chronological captures, date-stamped (Adelaide), photo
 * thumbnails, notes, audio player + transcript." Fed by every capture
 * from EITHER entry point (BUILD-SPEC item 1): /capture (team,
 * author_user_id) and the /trade/[token] capture section (trade,
 * author_contact_id) — both write the same site_captures table
 * (migration 050), so this one feed shows both without any
 * source-specific branching beyond the author label.
 *
 * Team access (not admin-only) — same trust tier as Gallery/
 * Documents/Board/Timeline: nothing here is financial. Mirrors
 * app/(dashboard)/projects/[id]/gallery/page.tsx's exact shape
 * (Header + ProjectTabs + a single client workspace component).
 */
export default async function ProjectSiteDiaryPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);

  const { data: project } = await supabase
    .from("projects")
    .select("id,name,client_name,client_token")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Site diary`} subtitleHref={`/projects/${id}`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="diary" isAdmin={info?.role === "admin"} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <SiteDiary projectId={id} />
      </main>
    </>
  );
}
