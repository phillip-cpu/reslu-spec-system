import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import type {
  AriaFollowupDraft,
  SubmitAriaFollowupDraftInput,
} from "@/types/aria-followups";

export const runtime = "nodejs";

async function requireAdmin() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  return { supabase, info };
}

/** Admin-only approval inbox used by Office and Aria's submit tool. */
export async function GET(request: NextRequest) {
  const { supabase, info } = await requireAdmin();
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can review follow-up drafts" }, { status: 403 });
  }

  const status = request.nextUrl.searchParams.get("status") ?? "pending";
  if (!new Set(["pending", "approved", "rejected", "sent", "failed"]).has(status)) {
    return NextResponse.json({ error: "Invalid status" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("aria_followup_drafts")
    .select(
      "*,lead:leads(id,first_name,surname_project,stage,follow_up_date)"
    )
    .eq("status", status)
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ drafts: (data ?? []) as AriaFollowupDraft[] });
}

/**
 * Aria submits draft copy only. This route cannot send, approve, change a
 * lead stage or alter the lead's follow-up date.
 */
export async function POST(request: NextRequest) {
  const { supabase, info } = await requireAdmin();
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can submit follow-up drafts" }, { status: 403 });
  }

  let body: SubmitAriaFollowupDraftInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const leadId = body.lead_id?.trim();
  const dedupeKey = body.dedupe_key?.trim();
  const recipientEmail = body.recipient_email?.trim().toLowerCase();
  const subject = body.subject?.trim();
  const draftBody = body.body?.trim();
  if (!leadId || !dedupeKey || !recipientEmail || !subject || !draftBody) {
    return NextResponse.json(
      { error: "lead_id, dedupe_key, recipient_email, subject and body are required" },
      { status: 400 }
    );
  }
  if (!recipientEmail.includes("@")) {
    return NextResponse.json({ error: "recipient_email is invalid" }, { status: 400 });
  }

  const { data: lead } = await supabase
    .from("leads")
    .select("id,email")
    .eq("id", leadId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  if (lead.email?.trim().toLowerCase() !== recipientEmail) {
    return NextResponse.json(
      { error: "recipient_email must match the lead's current email" },
      { status: 400 }
    );
  }

  const { data: existing } = await supabase
    .from("aria_followup_drafts")
    .select("*")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ draft: existing as AriaFollowupDraft, created: false });
  }

  const { data, error } = await supabase
    .from("aria_followup_drafts")
    .insert({
      lead_id: leadId,
      source_queue_id: body.source_queue_id ?? null,
      dedupe_key: dedupeKey,
      recipient_email: recipientEmail,
      subject,
      body: draftBody,
      context_summary: body.context_summary?.trim() || null,
      created_by: info.userId,
    })
    .select("*")
    .single();
  if (error || !data) {
    return NextResponse.json({ error: error?.message ?? "Could not save draft" }, { status: 500 });
  }

  return NextResponse.json(
    { draft: data as AriaFollowupDraft, created: true },
    { status: 201 }
  );
}
