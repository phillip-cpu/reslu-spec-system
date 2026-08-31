import { NextResponse } from "next/server";
import vercel from "@/vercel.json";
import { createClient } from "@/lib/supabase/server";
import { workroomRoutines } from "@/lib/workroom";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TaskRow = Record<string, unknown> & {
  id: string;
  conversation_id: string;
  owner_agent?: { id: string; slug: string; display_name: string; role_label: string; avatar_url: string | null } | null;
  conversation?: { id: string; title: string | null; kind: "direct" | "group" } | null;
};

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { data, error } = await supabase
    .from("agent_tasks")
    .select("*,owner_agent:conversation_agents!owner_agent_id(id,slug,display_name,role_label,avatar_url),conversation:conversations!conversation_id(id,title,kind)")
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as unknown as TaskRow[];
  const taskIds = rows.map((task) => task.id);
  const [eventsResult, artifactsResult, dismissalsResult] = taskIds.length > 0
    ? await Promise.all([
        supabase.from("agent_task_events").select("*").in("task_id", taskIds).order("created_at"),
        supabase.from("agent_task_artifacts").select("*").in("task_id", taskIds).order("created_at"),
        supabase.from("agent_task_dismissals").select("task_id").in("task_id", taskIds),
      ])
    : [{ data: [], error: null }, { data: [], error: null }, { data: [], error: null }];
  const relatedError = eventsResult.error ?? artifactsResult.error ?? dismissalsResult.error;
  if (relatedError) return NextResponse.json({ error: relatedError.message }, { status: 500 });

  const dismissed = new Set((dismissalsResult.data ?? []).map((row) => row.task_id));
  const tasks = rows.filter((task) => !dismissed.has(task.id)).map((task) => ({
    ...task,
    conversation: {
      id: task.conversation?.id ?? task.conversation_id,
      kind: task.conversation?.kind ?? "direct",
      title: task.conversation?.title?.trim() || task.owner_agent?.display_name || "Conversation",
    },
    events: (eventsResult.data ?? []).filter((event) => event.task_id === task.id),
    artifacts: (artifactsResult.data ?? []).filter((artifact) => artifact.task_id === task.id),
  }));

  return NextResponse.json({
    tasks,
    routines: workroomRoutines(vercel.crons),
    self_profile_id: user.id,
    generated_at: new Date().toISOString(),
  });
}
