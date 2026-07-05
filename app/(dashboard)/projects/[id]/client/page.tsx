import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ClientAreaWorkspace } from "@/components/client-area/ClientAreaWorkspace";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/client — team-side "Client area" (BUILD-SPEC.md
 * "Week 8 — Client portal expansion" / this task's "Team-side client
 * area"): progress photos upload, diary composer, contract/signature
 * flow, variation sharing controls, handover-pack curation — the
 * internal counterpart to the expanded client portal.
 *
 * Team access (not admin-only) EXCEPT variation sharing, which the
 * variations panel itself gates (both client-side for UX and
 * server-side in PATCH .../variations/[variationId]/share — the real
 * enforcement per BUILD-SPEC.md's financial-visibility pattern).
 *
 * Now linked from components/projects/ProjectTabs.tsx via the minimal
 * single-line diff added by this task (see this task's final report —
 * that file is not otherwise in this agent's boundary and is worked on
 * concurrently by the Phase 11A agent). Previously (Week 8B) this page
 * was reachable only by direct URL with no tab entry at all.
 */
export default async function ProjectClientAreaPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info] = await Promise.all([
    supabase.from("projects").select("id,name,client_name,client_token").eq("id", id).single(),
    getUserRole(supabase),
  ]);

  if (!project) {
    notFound();
  }

  const isAdmin = info?.role === "admin";

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Client area`} subtitleHref={`/projects/${id}`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="client" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <ClientAreaWorkspace
          projectId={id}
          portalToken={project.client_token}
          isAdmin={isAdmin}
        />
      </main>
    </>
  );
}
