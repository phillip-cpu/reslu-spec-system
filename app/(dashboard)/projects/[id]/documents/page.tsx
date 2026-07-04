import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectDocuments } from "@/components/projects/ProjectDocuments";

/**
 * /projects/[id]/documents (Week 6). Team-visible — NOT admin-gated,
 * per BUILD-SPEC.md "Project documents": "documents aren't financial".
 * Every signed-in team member can view and upload; delete is
 * client-side gated to admin-or-uploader, matching the API's own check
 * in app/api/project-files/[fileId]/route.ts (server-enforced there —
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
    .select("id, name, client_name")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Documents`} />
      <main className="flex-1 px-8 py-8">
        <ProjectDocuments
          projectId={id}
          currentUserId={user?.id ?? null}
          isAdmin={info?.role === "admin"}
        />
      </main>
    </>
  );
}
