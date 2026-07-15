import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { leadMeetingStoragePath } from "@/lib/lead-meetings";
import { ASSET_BUCKET } from "@/lib/storage";
import { createClient } from "@/lib/supabase/server";
import type { LeadMeetingUploadUrlResponse } from "@/types/lead-meetings";

export const runtime = "nodejs";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });

  const { data: lead } = await supabase.from("leads").select("id").eq("id", id).is("deleted_at", null).maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });

  const body = await request.json().catch(() => null);
  const filename = body && typeof body.filename === "string" ? body.filename.trim() : "meeting-audio.m4a";
  const path = leadMeetingStoragePath(id, info.userId, filename || "meeting-audio.m4a");
  const { data, error } = await supabase.storage.from(ASSET_BUCKET).createSignedUploadUrl(path);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const response: LeadMeetingUploadUrlResponse = { path: data.path, token: data.token };
  return NextResponse.json(response);
}

