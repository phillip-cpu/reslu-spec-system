import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; taskId: string }> };

export async function PATCH(request: NextRequest, context: Context) {
  const { id, taskId } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { action?: string; artifact_id?: string; note?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  if (body.action === "cancel") {
    const { data, error } = await supabase.rpc("cancel_agent_task", {
      p_conversation_id: id,
      p_task_id: taskId,
    }).single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not cancel task" }, { status: 400 });
    return NextResponse.json({ task: data });
  }

  if (body.action === "retry") {
    const { data, error } = await supabase.rpc("retry_failed_agent_task", {
      p_conversation_id: id,
      p_task_id: taskId,
    }).single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not retry task" }, { status: 400 });
    return NextResponse.json({ task: data });
  }

  if (body.action === "dismiss") {
    const { data: task, error: taskError } = await supabase
      .from("agent_tasks")
      .select("id,status")
      .eq("id", taskId)
      .eq("conversation_id", id)
      .maybeSingle();
    if (taskError || !task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!["failed", "completed", "cancelled"].includes(task.status)) {
      return NextResponse.json({ error: "Active Agent Work cannot be cleared. Stop it first." }, { status: 400 });
    }
    const { error } = await supabase.from("agent_task_dismissals").insert({
      task_id: taskId,
      profile_id: user.id,
    });
    if (error && error.code !== "23505") return NextResponse.json({ error: error.message }, { status: 400 });
    return NextResponse.json({ dismissed: true });
  }

  if ((body.action === "approve" || body.action === "reject") && body.artifact_id) {
    const { data, error } = await supabase.rpc("decide_agent_task_artifact", {
      p_conversation_id: id,
      p_task_id: taskId,
      p_artifact_id: body.artifact_id,
      p_approved: body.action === "approve",
      p_note: body.note?.trim() || null,
    }).single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not save approval" }, { status: 400 });
    return NextResponse.json({ task: data });
  }

  if (body.action === "request_changes" && body.artifact_id) {
    const { data, error } = await supabase.rpc("request_agent_task_artifact_changes", {
      p_conversation_id: id,
      p_task_id: taskId,
      p_artifact_id: body.artifact_id,
      p_note: body.note?.trim() || "",
    }).single();
    if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not return this review" }, { status: 400 });
    return NextResponse.json({ task: data });
  }

  return NextResponse.json({ error: "Invalid task action" }, { status: 400 });
}
