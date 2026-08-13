import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectConversationWorkspace } from "@/components/conversations/ProjectConversationWorkspace";
import { portalUrlFor } from "@/lib/portal-link";

export default async function ProjectMessagesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const [{ data: project }, info] = await Promise.all([
    supabase.from("projects").select("id,name,job_number,alias,client_name,client_token").eq("id", id).is("deleted_at", null).maybeSingle(),
    getUserRole(supabase),
  ]);
  if (!project) notFound();

  return (
    <>
      <Header
        title={project.name}
        jobNumber={project.job_number ?? null}
        titleSuffix={project.alias ?? null}
        subtitle={project.client_name}
        subtitleHref="/"
      />
      <ProjectTabs
        projectId={id}
        active="messages"
        isAdmin={info?.role === "admin"}
        portalUrl={portalUrlFor(project.client_token)}
      />
      <main className="min-h-0 flex-1 px-0 py-0 md:px-6 md:py-6">
        <ProjectConversationWorkspace projectId={id} projectName={project.name} />
      </main>
    </>
  );
}
