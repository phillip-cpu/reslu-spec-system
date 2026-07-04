import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectSettingsForm } from "@/components/settings/ProjectSettingsForm";
import type { Project } from "@/types";

/**
 * /projects/[id]/settings (Week 4 task).
 *
 * Audit before building (per instructions): no project-level settings
 * page existed in this working copy. The register page
 * (app/(dashboard)/projects/[id]/page.tsx — outside this build's file
 * boundary) has an inline MondayBoardPicker only; there was no
 * consolidated place for project field edits, the portal link, or
 * archiving. This page is net-new.
 *
 * Field edits are visible to every signed-in team member (matching
 * the register's own "team_all" trust model) but only editable by
 * admins — same visible-but-disabled pattern as the P&P financial
 * fields elsewhere. Archive and token-regeneration are admin-only
 * actions, hidden entirely (not just disabled) for non-admins.
 */
export default async function ProjectSettingsPage({
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
    .select("*")
    .eq("id", id)
    .single();

  if (!project) {
    notFound();
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";

  return (
    <>
      <Header title="Project settings" subtitle={project.name} />
      <main className="flex-1 px-8 py-8">
        <ProjectSettingsForm
          project={project as Project}
          isAdmin={isAdmin}
          appUrl={appUrl}
        />
      </main>
    </>
  );
}
