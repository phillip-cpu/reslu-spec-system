import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ProjectList } from "@/components/projects/ProjectList";
import type { ProjectWithCounts } from "@/types";

export default async function DashboardPage() {
  const supabase = await createClient();

  const { data: projects, error } = await supabase
    .from("projects")
    .select("*, items(count)")
    .neq("status", "archived")
    .order("updated_at", { ascending: false });

  const projectsWithCounts: ProjectWithCounts[] = (projects ?? []).map((p: any) => ({
    ...p,
    item_count: p.items?.[0]?.count ?? 0,
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
