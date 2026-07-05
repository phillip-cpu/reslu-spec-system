import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ProjectList } from "@/components/projects/ProjectList";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import { signedRenditionUrl, RENDITION_SIZES } from "@/lib/image-url";
import type { ProjectWithCountsAndAlias } from "@/types/phase-12a-b";

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: projects, error } = await supabase
    .from("projects")
    .select("*, items(count)")
    .neq("status", "archived")
    .order("updated_at", { ascending: false });

  // Cover images (Week 7): `assets` is a private bucket, so each
  // project's cover_image_path needs a signed URL minted server-side —
  // batched here (one signing call per project with a cover set) rather
  // than per-card, since this is a server component with the request-
  // scoped Supabase client already in hand.
  //
  // Phase 14A perf: this grid only ever displays the cover at card size
  // (see ProjectCard.tsx's aspect-[3/2] tile), so the signed URL is
  // minted with an inline resize transform (RENDITION_SIZES.card) via
  // lib/image-url.ts's signedRenditionUrl — Supabase resizes + edge-
  // caches the result instead of every card shipping the full-size
  // original. Falls back to an untransformed signed URL if the
  // transform call errors (e.g. transform add-on not enabled), so a
  // missing image-transform entitlement never breaks the dashboard.
  const coverUrlByProjectId = new Map<string, string>();
  const projectsWithCovers = (projects ?? []).filter((p) => p.cover_image_path);
  if (projectsWithCovers.length > 0) {
    await Promise.all(
      projectsWithCovers.map(async (p) => {
        const rendition = await signedRenditionUrl(
          supabase,
          ASSET_BUCKET,
          p.cover_image_path as string,
          SIGNED_URL_TTL_SECONDS,
          { width: RENDITION_SIZES.card }
        );
        if (rendition) {
          coverUrlByProjectId.set(p.id, rendition);
          return;
        }
        const { data: signed } = await supabase.storage
          .from(ASSET_BUCKET)
          .createSignedUrl(p.cover_image_path as string, SIGNED_URL_TTL_SECONDS);
        if (signed?.signedUrl) coverUrlByProjectId.set(p.id, signed.signedUrl);
      })
    );
  }

  const projectsWithCounts: ProjectWithCountsAndAlias[] = (projects ?? []).map((p: any) => ({
    ...p,
    item_count: p.items?.[0]?.count ?? 0,
    cover_image_url: coverUrlByProjectId.get(p.id) ?? null,
  }));

  return (
    <>
      <Header
        title="Projects"
        actions={
          <Link
            href="/projects/new"
            className="bg-nearblack text-white px-4 py-2 text-subhead hover:bg-charcoal transition-colors"
          >
            New Project
          </Link>
        }
      />
      <main className="flex-1 px-8 py-8">
        {error && (
          <p className="text-body text-red-700 mb-4">
            Could not load projects: {error.message}
          </p>
        )}
        <ProjectList projects={projectsWithCounts} />
      </main>
    </>
  );
}
