import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectOverview } from "@/components/projects/ProjectOverview";
import { ProjectWorkspace } from "@/components/items/ProjectWorkspace";
import { MondayBoardPicker } from "@/components/items/MondayBoardPicker";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { portalUrlFor } from "@/lib/portal-link";
import { getCategories } from "@/lib/reference-data";
import type { Category, Item } from "@/types";

/**
 * Project overview hub (Week 8A — BUILD-SPEC.md "Project overview
 * hub"). /projects/[id] now shows the Overview tab by default (cards:
 * FF&E, Documents with traffic lights, Estimate summary [admin only],
 * Client activity) behind a persistent tab bar. `?tab=ffe` renders the
 * FF&E tab in place — the pre-Week-8 Spec Register/Pricing &
 * Procurement workspace, unchanged, just moved under the tab bar
 * rather than being the page's only content. Every other tab
 * (Documents/Estimate/Invoices/Settings) is a pre-existing route the
 * tab bar links to directly (BUILD-SPEC.md: "'tabs' may be styled
 * links, simplest and best") — no deep link changes.
 */
export default async function ProjectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;
  const showFfe = tab === "ffe";
  const supabase = await createClient();

  const [{ data: project }, info] = await Promise.all([
    supabase.from("projects").select("*").eq("id", id).single(),
    getUserRole(supabase),
  ]);

  if (!project) {
    notFound();
  }

  // Invoices/Estimate tabs are financial — hidden entirely for
  // non-admins (same "hidden, not merely disabled" pattern as the
  // pre-Week-8 header's admin-gated Invoices link). The routes
  // themselves independently re-check admin server-side regardless.
  const isAdmin = info?.role === "admin";

  // Cover image thumbnail next to the title (Week 7) — `assets` is
  // private, so a signed URL is minted server-side here, same pattern
  // as the dashboard cards and the settings page's preview.
  let coverImageUrl: string | null = null;
  if (project.cover_image_path) {
    const { data: signed } = await supabase.storage
      .from(ASSET_BUCKET)
      .createSignedUrl(project.cover_image_path, SIGNED_URL_TTL_SECONDS);
    coverImageUrl = signed?.signedUrl ?? null;
  }

  // The FF&E tab needs the full items/categories list; Overview fetches
  // its own summary client-side (GET /api/projects/[id]/overview) so
  // switching tabs doesn't pay for both queries on every load.
  let items: Item[] = [];
  let categories: Category[] = [];
  if (showFfe) {
    // Phase 14A caching: categories are stable reference data — see
    // lib/reference-data.ts. items stays a live, per-project,
    // uncached fetch (correctly so — it changes constantly).
    const [itemsRes, cachedCategories] = await Promise.all([
      supabase
        .from("items")
        .select("*")
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("category", { ascending: true })
        .order("item_code", { ascending: true }),
      getCategories(),
    ]);
    items = (itemsRes.data ?? []) as Item[];
    categories = cachedCategories;
  }

  return (
    <>
      <Header
        title={project.name}
        titleSuffix={project.alias ?? null}
        subtitle={project.client_name}
        subtitleHref="/"
        titleThumbnailUrl={coverImageUrl}
        actions={
          showFfe ? (
            <>
              <MondayBoardPicker
                projectId={id}
                currentBoardId={project.monday_board_id ?? null}
              />
              <a
                href={`/projects/${id}/import`}
                className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
              >
                Import CSV
              </a>
              <a
                href={`/api/projects/${id}/pdf`}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
              >
                Download PDF
              </a>
            </>
          ) : undefined
        }
      />
      <ProjectTabs
        projectId={id}
        active={showFfe ? "ffe" : "overview"}
        isAdmin={isAdmin}
        portalUrl={portalUrlFor(project.client_token)}
      />
      <main className="flex-1 px-8 py-8">
        {showFfe ? (
          <ProjectWorkspace
            projectId={id}
            initialItems={items}
            categories={categories}
            budget={project.budget ?? null}
          />
        ) : (
          <ProjectOverview projectId={id} isAdmin={isAdmin} />
        )}
      </main>
    </>
  );
}
