import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** Read one ingested email exactly. Admin-only because email bodies may contain client or supplier information. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data: email, error } = await supabase
    .from("emails")
    .select("id,message_id,thread_id,from_addr,subject,received_at,clean_text,direction,triage_label,triage_confidence,status,ingested_mailboxes")
    .eq("id", id)
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!email) return NextResponse.json({ error: "Email not found" }, { status: 404 });

  const { data: attachments, error: attachmentError } = await supabase
    .from("email_attachments")
    .select("id,filename,mime,extracted_text,extraction_method,needs_vision,page_count,kept_pages")
    .eq("email_id", id);
  if (attachmentError) {
    return NextResponse.json({ error: attachmentError.message }, { status: 500 });
  }

  return NextResponse.json({ email, attachments: attachments ?? [] });
}
