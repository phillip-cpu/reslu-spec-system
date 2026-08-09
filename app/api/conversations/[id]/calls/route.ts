import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { presentation?: "office" | "driving" | "meeting" } = {};
  try { body = await request.json(); } catch { /* defaults are safe */ }
  const presentation = ["office", "driving", "meeting"].includes(body.presentation ?? "") ? body.presentation : "office";
  const { data, error } = await supabase
    .from("conversation_calls")
    .insert({ conversation_id: id, started_by: user.id, presentation })
    .select("*")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not start call" }, { status: 500 });
  return NextResponse.json({ call: data }, { status: 201 });
}

export async function PATCH(request: NextRequest, context: Context) {
  const { id } = await context.params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  let body: { call_id?: string; summary?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  if (!body.call_id) return NextResponse.json({ error: "call_id is required" }, { status: 400 });
  const endedAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("conversation_calls")
    .update({ status: "ended", ended_at: endedAt, summary: body.summary?.trim() || null })
    .eq("id", body.call_id)
    .eq("conversation_id", id)
    .eq("started_by", user.id)
    .eq("status", "active")
    .select("*")
    .single();
  if (error || !data) return NextResponse.json({ error: error?.message ?? "Could not end call" }, { status: 500 });
  const durationSeconds = Math.max(0, Math.round((Date.parse(endedAt) - Date.parse(data.started_at)) / 1000));
  await supabase.from("conversation_messages").insert({
    conversation_id: id,
    author_profile_id: user.id,
    kind: "call_record",
    body: body.summary?.trim() || `Call ended after ${Math.max(1, Math.round(durationSeconds / 60))} min.`,
    metadata: { call_id: data.id, duration_seconds: durationSeconds, presentation: data.presentation },
  });
  return NextResponse.json({ call: data });
}
