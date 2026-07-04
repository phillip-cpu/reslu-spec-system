import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Header } from "@/components/layout/Header";
import { ProjectWorkspace } from "@/components/items/ProjectWorkspace";
import { MondayBoardPicker } from "@/components/items/MondayBoardPicker";
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

  const [{ data: project }, { data: items }, { data: categories }] =
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
    ]);

  if (!project) {
    notFound();
  }

  return (
    <>
      <Header
        title={project.name}
        subtitle={project.client_name}
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
            <a
              href={`/api/projects/${id}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              className="border border-nearblack px-4 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white"
            >
              Download PDF
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
