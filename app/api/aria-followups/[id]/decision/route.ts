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
    return NextResponse.json({ error: "Only admins can decide follow-up drafts" }, { status: 403 });
  }

  let body: { decision?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return NextResponse.json({ error: "decision must be approve or reject" }, { status: 400 });
  }

  const { data: draft } = await supabase
    .from("aria_followup_drafts")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!draft) return NextResponse.json({ error: "Draft not found" }, { status: 404 });
  if (draft.status !== "pending") {
    return NextResponse.json({ error: "This draft has already been decided" }, { status: 409 });
  }

  const approved = body.decision === "approve";
  const decidedAt = new Date().toISOString();
  const { data: updated, error } = await supabase
    .from("aria_followup_drafts")
    .update({
      status: approved ? "approved" : "rejected",
      approved_by: info.userId,
      approved_at: approved ? decidedAt : null,
      decision_note: body.note?.trim() || null,
      resolved_at: approved ? null : decidedAt,
    })
    .eq("id", id)
    .eq("status", "pending")
    .select("*")
    .single();
  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Could not decide draft" }, { status: 500 });
  }

  if (approved) {
    const { error: queueError } = await supabase.from("aria_queue").upsert(
      {
        kind: "followup_approved",
        dedupe_key: `followup_approved:${updated.id}`,
        source: "aria-followup-approval",
        payload: {
          action: "send_approved_followup",
          draft_id: updated.id,
          lead_id: updated.lead_id,
          recipient_email: updated.recipient_email,
          subject: updated.subject,
          body: updated.body,
          instruction:
            "Phillip explicitly approved this exact draft for sending. Send it once from the RESLU business email without rewriting it, then call complete_followup_send with the result.",
        },
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    );
    if (queueError) {
      await supabase
        .from("aria_followup_drafts")
        .update({
          status: "pending",
          approved_by: null,
          approved_at: null,
          decision_note: null,
        })
        .eq("id", updated.id)
        .eq("status", "approved");
      return NextResponse.json(
        { error: `Aria could not be queued, so the draft remains pending: ${queueError.message}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ draft: updated });
}
