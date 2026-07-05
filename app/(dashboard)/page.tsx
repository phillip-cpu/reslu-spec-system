import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ProjectList } from "@/components/projects/ProjectList";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
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
  const coverUrlByProjectId = new Map<string, string>();
  const projectsWithCovers = (projects ?? []).filter((p) => p.cover_image_path);
  if (projectsWithCovers.length > 0) {
    await Promise.all(
      projectsWithCovers.map(async (p) => {
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
