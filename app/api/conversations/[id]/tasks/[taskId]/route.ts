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

  return NextResponse.json({ error: "Invalid task action" }, { status: 400 });
}
