import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { EmailSendsResponse, VisitEmailRecordType } from "@/types/visit-emails";

export const runtime = "nodejs";

/**
 * GET /api/visit-emails?record_type=lead|client_event&record_id=<uuid>
 *
 * Any authenticated team member — email_sends carries no financial
 * data and both source tables' own RLS is already the permissive
 * team_all shape (leads: migration 014; client_events: migration 020),
 * same reasoning as every other non-admin-gated read in this codebase.
 * Note leads themselves ARE admin-gated at the route level
 * (app/api/leads/**) — this endpoint doesn't re-derive that gate since
 * its only caller for lead records (LeadDetailPanel) already lives
 * behind the admin-only /leads page; a non-admin never reaches the
 * component that would call this with record_type=lead.
 *
 * Returns every logged send for the record, newest first — powers the
 * "last-sent chip" on LeadDetailPanel / ClientEventsPanel
 * (components/shared/VisitEmailStatusChips.tsx).
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const recordType = searchParams.get("record_type") as VisitEmailRecordType | null;
  const recordId = searchParams.get("record_id");

  if (recordType !== "lead" && recordType !== "client_event") {
    return NextResponse.json({ error: "record_type must be 'lead' or 'client_event'" }, { status: 400 });
  }
  if (!recordId) {
    return NextResponse.json({ error: "record_id is required" }, { status: 400 });
  }

  const { data: sends, error } = await supabase
    .from("email_sends")
    .select("*")
    .eq("record_type", recordType)
    .eq("record_id", recordId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const body: EmailSendsResponse = { sends: sends ?? [] };
  return NextResponse.json(body);
}
