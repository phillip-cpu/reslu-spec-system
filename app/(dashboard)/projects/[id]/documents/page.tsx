import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectDocuments } from "@/components/projects/ProjectDocuments";
import { portalUrlFor } from "@/lib/portal-link";
import type { Project } from "@/types";

/**
 * /projects/[id]/documents (Week 6; Week 8A adds traffic lights on
 * each section header — BUILD-SPEC.md "Project overview hub"). Team-
 * visible — NOT admin-gated, per BUILD-SPEC.md "Project documents":
 * "documents aren't financial". Every signed-in team member can view
 * and upload; delete is client-side gated to admin-or-uploader,
 * matching the API's own check in
 * app/api/project-files/[fileId]/route.ts (server-enforced there —
 * this page's isAdmin/currentUserId are passed through for display
 * only, not as the security boundary).
 */
export default async function ProjectDocumentsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const info = user ? await getUserRole(supabase) : null;

  const { data: project } = await supabase
    .from("projects")
    .select("id, name, client_name, client_token, document_status")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  const isAdmin = info?.role === "admin";

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Documents`} titleHref={`/projects/${id}`} />
      <ProjectTabs projectId={id} active="documents" isAdmin={isAdmin} portalUrl={portalUrlFor(project.client_token)} />
      <main className="flex-1 px-8 py-8">
        <ProjectDocuments
          projectId={id}
          currentUserId={user?.id ?? null}
          isAdmin={isAdmin}
          initialDocumentStatus={(project as Pick<Project, "document_status">).document_status}
        />
      </main>
    </>
  );
}
