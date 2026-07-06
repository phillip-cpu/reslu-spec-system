import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { DesignTab } from "@/components/projects/design/DesignTab";
import { portalUrlFor } from "@/lib/portal-link";

/**
 * /projects/[id]/design — the Design Framework tab (Phase 12b,
 * BUILD-SPEC.md §"12b Design Framework"). Team-visible — NOT
 * admin-gated, design work carries no pricing/financial data at all
 * (see app/api/design-tasks/route.ts's own verification note), same
 * trust tier as /projects/[id]/board and /projects/[id]/timeline.
 *
 * currentUserId is resolved server-side here (same pattern as
 * OfficePage/board pages) and passed down to DesignTab purely so its
 * add-task composer can pre-check "assign to me" — there is no
 * GET /api/profiles list/me route in this codebase (see
 * types/phase-13.ts's OfficeTeamMember doc comment for the standing
 * reason), so every existing multi-assignee UI resolves the current
 * user server-side rather than via an extra client fetch.
 */
export default async function DesignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info, { data: { user } }] = await Promise.all([
    supabase.from("projects").select("id, name, client_name, client_token").eq("id", id).single(),
    getUserRole(supabase),
    supabase.auth.getUser(),
  ]);

  if (!project) {
    notFound();
  }

  const isAdmin = info?.role === "admin";

  return (
    <>
      <Header
        title={project.name}
        subtitle={`${project.client_name} · Design Framework`}
        titleHref={`/projects/${id}`}
      />
      <ProjectTabs
        projectId={id}
        active="design"
        isAdmin={isAdmin}
        portalUrl={portalUrlFor(project.client_token)}
      />
      <main className="flex-1 px-8 py-8">
        <DesignTab projectId={id} currentUserId={user?.id ?? ""} />
      </main>
    </>
  );
}
