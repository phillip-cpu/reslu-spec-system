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
 * Scope is part of the Work planning flow: it defines the trade package
 * before tasks are booked, so the Work sub-navigation remains visible here.
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
      <ProjectTabs projectId={id} active="sow" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        <SowBuilder projectId={id} />
      </main>
    </>
  );
}
