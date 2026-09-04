import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

export interface BoardTaskSowContext {
  sow_revision_label: string | null;
  sow_line_count: number;
  sow_scope_stale: boolean;
}

/**
 * Adds the small Scope provenance projection shared by the server-rendered
 * Board page and its client refresh API. All lookups are batched; tasks with no
 * Scope connection retain null/zero/false defaults.
 */
export async function addSowContextToBoardTasks<
  T extends { id: string; sow_revision_id?: string | null },
>(supabase: SupabaseClient, projectId: string, tasks: T[]): Promise<(T & BoardTaskSowContext)[]> {
  if (tasks.length === 0) return [];
  const taskIds = tasks.map((task) => task.id);
  const revisionIds = [...new Set(tasks.map((task) => task.sow_revision_id).filter(Boolean))] as string[];

  const [linksResult, revisionsResult, latestResult] = await Promise.all([
    supabase.from("board_task_sow_lines").select("task_id").in("task_id", taskIds),
    revisionIds.length
      ? supabase.from("sow_documents").select("id,revision_label").in("id", revisionIds)
      : Promise.resolve({ data: [] as { id: string; revision_label: string }[] }),
    supabase
      .from("sow_documents")
      .select("id")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const lineCountByTask = new Map<string, number>();
  for (const link of linksResult.data ?? []) {
    const taskId = link.task_id as string;
    lineCountByTask.set(taskId, (lineCountByTask.get(taskId) ?? 0) + 1);
  }
  const revisionLabelById = new Map(
    (revisionsResult.data ?? []).map((revision) => [revision.id as string, revision.revision_label as string])
  );
  const latestSowId = latestResult.data?.id as string | undefined;

  return tasks.map((task) => ({
    ...task,
    sow_revision_label: task.sow_revision_id
      ? revisionLabelById.get(task.sow_revision_id) ?? null
      : null,
    sow_line_count: lineCountByTask.get(task.id) ?? 0,
    sow_scope_stale: Boolean(
      task.sow_revision_id && latestSowId && task.sow_revision_id !== latestSowId
    ),
  }));
}
