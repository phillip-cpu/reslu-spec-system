import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { Header } from "@/components/layout/Header";
import { ProjectTabs } from "@/components/projects/ProjectTabs";
import { ProjectBoard } from "@/components/board/ProjectBoard";
import type { BoardColumnWithTasks, BoardTaskWithRefs } from "@/types";

const DEFAULT_COLUMNS = ["To Do", "In Progress", "Waiting", "Done"];
const SORT_STEP = 1000;

/**
 * /projects/[id]/board — Week 9 kanban tab (BUILD-SPEC.md "Project
 * board"). Team-visible, not admin-gated (task/scheduling data, no
 * pricing). Follows this codebase's established sub-page convention
 * (documents/estimate/invoices/overview all query Supabase directly
 * server-side via createClient() rather than internally fetching their
 * own API routes) — so the seed-columns-on-first-visit logic is
 * duplicated here (small, ~15 lines) rather than the page making a
 * same-origin HTTP round-trip back into GET /api/projects/[id]/board
 * to get the identical result. The API route keeps its own copy of
 * this seeding for non-page callers (Aria, the client-side refresh
 * after a mutation) — both copies are intentionally identical in
 * shape (idempotent: only seeds if the project currently has zero
 * columns) so neither can drift into double-seeding a project.
 */
export default async function ProjectBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();

  const [{ data: project }, info, { data: team }] = await Promise.all([
    supabase.from("projects").select("id, name, client_name").eq("id", id).single(),
    getUserRole(supabase),
    supabase.from("profiles").select("id, full_name").order("full_name"),
  ]);

  if (!project) {
    notFound();
  }
  const isAdmin = info?.role === "admin";

  let { data: columns } = await supabase
    .from("board_columns")
    .select("*")
    .eq("project_id", id)
    .order("sort", { ascending: true });

  if (!columns || columns.length === 0) {
    const seedRows = DEFAULT_COLUMNS.map((name, i) => ({
      project_id: id,
      name,
      sort: i * SORT_STEP,
    }));
    const { data: seeded } = await supabase.from("board_columns").insert(seedRows).select();
    columns = seeded ?? [];
  }

  const columnIds = columns.map((c) => c.id);
  const { data: tasks } = columnIds.length
    ? await supabase
        .from("board_tasks")
        .select("*")
        .in("column_id", columnIds)
        .is("deleted_at", null)
        .order("sort", { ascending: true })
    : { data: [] };

  const assigneeIds = [...new Set((tasks ?? []).map((t) => t.assignee_id).filter(Boolean))] as string[];
  const contactIds = [...new Set((tasks ?? []).map((t) => t.contact_id).filter(Boolean))] as string[];

  const [{ data: assigneeProfiles }, { data: contacts }] = await Promise.all([
    assigneeIds.length
      ? supabase.from("profiles").select("id,full_name").in("id", assigneeIds)
      : Promise.resolve({ data: [] as { id: string; full_name: string }[] }),
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null }[] }),
  ]);

  const profileById = new Map((assigneeProfiles ?? []).map((p) => [p.id, p]));
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  const tasksByColumn = new Map<string, BoardTaskWithRefs[]>();
  for (const t of tasks ?? []) {
    const withRefs: BoardTaskWithRefs = {
      ...t,
      assignee: t.assignee_id ? profileById.get(t.assignee_id) ?? null : null,
      contact: t.contact_id ? contactById.get(t.contact_id) ?? null : null,
    };
    const list = tasksByColumn.get(t.column_id) ?? [];
    list.push(withRefs);
    tasksByColumn.set(t.column_id, list);
  }

  const initialColumns: BoardColumnWithTasks[] = columns.map((c) => ({
    ...c,
    tasks: tasksByColumn.get(c.id) ?? [],
  }));

  return (
    <>
      <Header title={project.name} subtitle={`${project.client_name} · Board`} />
      <ProjectTabs projectId={id} active="board" isAdmin={isAdmin} />
      <main className="flex-1 px-8 py-8">
        <ProjectBoard projectId={id} initialColumns={initialColumns} team={team ?? []} />
      </main>
    </>
  );
}
