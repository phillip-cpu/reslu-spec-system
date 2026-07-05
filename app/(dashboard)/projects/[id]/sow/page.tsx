import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { SowBuilder } from "@/components/sow/SowBuilder";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/sow — the Scope of Works builder (BUILD-SPEC.md
 * "Scope of Works builder"). Team-visible — NOT admin-gated, a SOW
 * isn't financial data, same trust tier as /projects/[id]/documents.
 * Linked from the Documents tab's Scope of Works section. The tab bar
 * highlights "Documents" here (there is no separate top-level SOW tab
 * in BUILD-SPEC.md's "Project overview hub" list — Overview | FF&E |
 * Documents | Estimate | Invoices | Settings — this page is reached
 * as a drill-down from Documents, same relationship as
 * /projects/[id]/import has to FF&E).
 */
export default async function SowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  const isAdmin = info?.role === "admin";

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_name, client_token")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Scope of Works`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="documents" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <SowBuilder projectId={id} />
      </main>
    </>
  );
}
