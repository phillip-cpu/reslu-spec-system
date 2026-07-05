import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateOfficeSubtaskInput } from "@/types/phase-13";

const SORT_STEP = 1000;

/**
 * POST /api/office/subtasks
 * body: { task_id (required), title (required) }. Response: { subtask }.
 * Monday-"subitems" equivalent (docs/OFFICE-BRIEF.md) — a simple
 * tick-list step under an office_tasks row, driving the '2/5' progress
 * chip in the grouped list view.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateOfficeSubtaskInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.task_id || !body.title?.trim()) {
    return NextResponse.json({ error: "task_id and title are required" }, { status: 400 });
  }

  const { data: task } = await supabase
    .from("office_tasks")
    .select("id")
    .eq("id", body.task_id)
    .is("deleted_at", null)
    .single();
  if (!task) {
    return NextResponse.json({ error: "task_id does not exist" }, { status: 400 });
  }

  const { data: maxRow } = await supabase
    .from("office_subtasks")
    .select("sort")
    .eq("task_id", body.task_id)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: subtask, error } = await supabase
    .from("office_subtasks")
    .insert({ task_id: body.task_id, title: body.title.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ subtask }, { status: 201 });
}
