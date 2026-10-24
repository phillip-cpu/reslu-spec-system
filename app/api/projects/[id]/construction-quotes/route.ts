import { constructionQuoteWritesReady, QUOTE_NOT_READY } from "@/lib/construction-quote-access";
import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { emptyQuote, quoteContent, isConstructionQuote } from "@/lib/construction-quotes";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await createClient();
  const user = await getUserRole(db);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  if (!await constructionQuoteWritesReady(db)) return NextResponse.json({ error: QUOTE_NOT_READY }, { status: 503 });
  const { id } = await params;
  let body;
  try { body = await request.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  if (!body || typeof body.request_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.request_id)) return NextResponse.json({ error: "Request identity required" }, { status: 400 });
  const { data: project } = await db.from("projects").select("id").eq("id", id).maybeSingle();
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  // A retry uses the same id; only this project's quote can satisfy it.
  const { data, error } = await db.from("proposals").insert({ id: body.request_id, project_id: id, lead_id: null, status: "draft", content: quoteContent(emptyQuote()), total_inc: 0, deposit_inc: 0 }).select().single();
  if (error?.code === "23505") {
    const { data: existing } = await db.from("proposals").select("*").eq("id", body.request_id).eq("project_id", id).maybeSingle();
    if (existing && isConstructionQuote(existing.content)) return NextResponse.json({ proposal: existing });
    return NextResponse.json({ error: "Request identity conflict" }, { status: 409 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ proposal: data }, { status: 201 });
}
