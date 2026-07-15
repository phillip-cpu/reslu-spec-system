import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can complete follow-up sends" }, { status: 403 });
  }

  let body: { status?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.status !== "sent" && body.status !== "failed") {
    return NextResponse.json({ error: "status must be sent or failed" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("aria_followup_drafts")
    .update({
      status: body.status,
      decision_note: body.note?.trim() || null,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "approved")
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json(
      { error: error?.message ?? "Approved draft not found" },
      { status: error?.code === "PGRST116" ? 409 : 500 }
    );
  }
  return NextResponse.json({ draft: data });
}
