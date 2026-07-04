import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectWorkspace } from "@/components/items/ProjectWorkspace";
import { MondayBoardPicker } from "@/components/items/MondayBoardPicker";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type { Category, Item } from "@/types";

/**
 * Spec Register (Week 2).
 * Programa-style editable, room-grouped grid over the project's items.
 * Spec view only — no pricing or ordering data (BUILD-SPEC.md §1–2);
 * those live in the internal Pricing & Procurement view (later sprint).
 */
export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, { data: items }, { data: categories }, info] =
    await Promise.all([
      supabase.from("projects").select("*").eq("id", id).single(),
      supabase
        .from("items")
        .select("*")
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("category", { ascending: true })
        .order("item_code", { ascending: true }),
      supabase.from("categories").select("*").order("sort_order"),
      getUserRole(supabase),
    ]);

  if (!project) {
    notFound();
  }

  // Invoices queue is financial — link only rendered for admins (same
  // "hidden entirely, not merely disabled" pattern as the archive/
  // regenerate-token actions in ProjectSettingsForm.tsx). The route
  // itself (app/api/projects/[id]/invoices/**) independently re-checks
  // admin server-side regardless of this UI gate.
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

  return (
    <>
      <Header
        title={project.name}
        subtitle={project.client_name}
        subtitleHref="/"
        titleThumbnailUrl={coverImageUrl}
        actions={
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
            {/* Project documents (Week 6, team-visible — not admin-gated,
                see app/(dashboard)/projects/[id]/documents/page.tsx) */}
            <a
              href={`/projects/${id}/documents`}
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Documents
            </a>
            {/* Estimate module (Week 5, admin-gated — see app/(dashboard)/projects/[id]/estimate/page.tsx) */}
            <a
              href={`/projects/${id}/estimate`}
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Estimate
            </a>
            {/* Invoice queue (Week 6, admin-only — financial, see
                app/(dashboard)/projects/[id]/invoices/page.tsx) */}
            {isAdmin && (
              <a
                href={`/projects/${id}/invoices`}
                className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
              >
                Invoices
              </a>
            )}
            <a
              href={`/api/projects/${id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Download PDF
            </a>
            <a
              href={`/projects/${id}/settings`}
              className="border border-[#c9c2b4] px-4 py-2 text-subhead text-charcoal transition-colors hover:border-nearblack hover:text-nearblack"
            >
              Settings
            </a>
          </>
        }
      />
      <main className="flex-1 px-8 py-8">
        <ProjectWorkspace
          projectId={id}
          initialItems={(items ?? []) as Item[]}
          categories={(categories ?? []) as Category[]}
          budget={project.budget ?? null}
        />
      </main>
    </>
  );
}
