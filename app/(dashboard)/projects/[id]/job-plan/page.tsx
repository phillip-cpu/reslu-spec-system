import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { JobPlanWorkspace } from "@/components/job-plan/JobPlanWorkspace";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { getUserRole } from "@/lib/auth";
import { loadJobPlanPageData } from "@/lib/job-plan-server";
import { portalUrlFor } from "@/lib/portal-link";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectJobPlanPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  const data = await loadJobPlanPageData(supabase, id, info?.role === "admin");
  if (!data) notFound();

  return (
    <>
      <Header
        title={data.project.name}
        subtitle={`${data.project.client_name} · Connected job plan`}
        titleHref={`/projects/${id}`}
      />
      <ProjectTabs
        projectId={id}
        active="job-plan"
        isAdmin={data.is_admin}
        portalUrl={portalUrlFor(data.project.client_token)}
      />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        <JobPlanWorkspace projectId={id} initialModel={data.model} isAdmin={data.is_admin} />
      </main>
    </>
  );
}
