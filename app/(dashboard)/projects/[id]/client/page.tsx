import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ClientAreaWorkspace } from "@/components/client-area/ClientAreaWorkspace";

/**
 * /projects/[id]/client — team-side "Client area" (BUILD-SPEC.md
 * "Week 8 — Client portal expansion" / this task's "Team-side client
 * area"): progress photos upload, update posts, contract/signature
 * flow, variation sharing controls — the internal counterpart to the
 * expanded client portal.
 *
 * Team access (not admin-only) EXCEPT variation sharing, which the
 * variations panel itself gates (both client-side for UX and
 * server-side in PATCH .../variations/[variationId]/share — the real
 * enforcement per BUILD-SPEC.md's financial-visibility pattern).
 *
 * Not linked from components/projects/ProjectTabs.tsx (that file is
 * outside this agent's boundary — components/projects/** is owned by
 * the Week 8A agent). Reachable today via direct URL; adding a "Client"
 * tab entry to ProjectTabs is a one-line follow-up for whichever agent
 * next touches that file. See this task's final report.
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

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Client area`} subtitleHref={`/projects/${id}`} />
      <main className="flex-1 px-8 py-8">
        <ClientAreaWorkspace
          projectId={id}
          portalToken={project.client_token}
          isAdmin={info?.role === "admin"}
        />
      </main>
    </>
  );
}
