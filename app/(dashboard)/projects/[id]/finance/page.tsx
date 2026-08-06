import { notFound } from "next/navigation";
import { Header } from "@/components/layout/Header";
import { ProjectFinanceWorkspace } from "@/components/finance/ProjectFinanceWorkspace";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { getUserRole } from "@/lib/auth";
import { financeFoundationEnabled } from "@/lib/finance/feature-flags";
import { hasFinanceCapability } from "@/lib/finance/permissions";
import { portalUrlFor } from "@/lib/portal-link";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectFinancePage({
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
    .select("id,name,client_name,client_token")
    .eq("id", id)
    .maybeSingle();
  if (!project) notFound();

  let unavailable: string | null = null;
  if (!financeFoundationEnabled()) {
    unavailable = "The finance kill switch is off. Apply migration 080 and complete the permission checks before enabling it.";
  } else if (!info) {
    unavailable = "Sign in to access project finance.";
  } else {
    const permission = await hasFinanceCapability(supabase, "finance.view_project", id);
    unavailable = permission.error
      ? `Finance is not configured: ${permission.error}`
      : permission.allowed
        ? null
        : "This project finance view is restricted. Ask a finance administrator for access.";
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Finance`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="finance" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-4 py-6 md:px-8 md:py-8">
        {unavailable ? (
          <div className="mx-auto max-w-xl border border-charcoal/20 bg-offwhite p-8 text-center">
            <p className="label-caps">Project finance unavailable</p>
            <p className="mt-3 text-body text-charcoal/60">{unavailable}</p>
          </div>
        ) : (
          <ProjectFinanceWorkspace projectId={id} />
        )}
      </main>
    </>
  );
}
