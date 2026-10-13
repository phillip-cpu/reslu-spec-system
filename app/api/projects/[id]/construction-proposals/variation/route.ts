import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { buildConstructionVariation, isConstruction } from "@/lib/construction-proposals";
import { constructionDigest, constructionDraftId } from "@/lib/construction-proposal-identity";
export const runtime = "nodejs";
async function admin() {
  const db = await createClient(); const user = await getUserRole(db);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { response: NextResponse.json({ error: "Admin access required" }, { status: 403 }) };
  return { db };
}
async function load(db: Awaited<ReturnType<typeof createClient>>, id: string, baseId: string) {
  const [{ data: base }, { data: packages, error }] = await Promise.all([
    db.from("proposals").select("*").eq("id", baseId).eq("project_id", id).eq("status", "accepted").maybeSingle(),
    db.from("client_contract_variations").select("id,project_id,label,amount_inc_gst,updated_at").eq("project_id", id).eq("status", "active").is("deleted_at", null).order("id"),
  ]);
  if (error || !base || !isConstruction(base.content) || base.content.construction.variation) throw new Error("Accepted original proposal or variation packages unavailable.");
  return { base, packages: packages ?? [], source_digest: constructionDigest({ base, packages }) };
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await admin(); if ("response" in auth) return auth.response;
  try {
    const { id } = await params;
    const data = await load(auth.db, id, request.nextUrl.searchParams.get("base_id") ?? "");
    return NextResponse.json({ source_digest: data.source_digest, packages: data.packages }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await admin(); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null);
  if (!body || typeof body.base_id !== "string" || typeof body.package_id !== "string") return NextResponse.json({ error: "Choose the accepted proposal and existing variation package." }, { status: 400 });
  try {
    const { id } = await params; const data = await load(auth.db, id, body.base_id);
    if (body.source_digest !== data.source_digest) return NextResponse.json({ error: "Variation sources changed. Reload before generating." }, { status: 409 });
    const pack = data.packages.find(p => p.id === body.package_id);
    if (!pack) return NextResponse.json({ error: "Variation package not found for this project." }, { status: 404 });
    if (!data.base.construction_version_digest) return NextResponse.json({ error: "Original proposal has no database-verified version digest." }, { status: 409 });
    const content = buildConstructionVariation({ base: data.base, baseDigest: data.base.construction_version_digest, sourceDigest: data.source_digest, package: pack, description: body.description, time_effect_days: body.time_effect_days, time_effect_note: body.time_effect_note });
    const proposalId = constructionDraftId(id, content);
    const { data: proposal, error } = await auth.db.from("proposals").insert({ id: proposalId, project_id: id, lead_id: null, status: "draft", content, total_inc: content.construction.total_inc, deposit_inc: 0 }).select().single();
    if (error?.code === "23505") {
      const { data: existing } = await auth.db.from("proposals").select("id,content").eq("id", proposalId).eq("project_id", id).maybeSingle();
      if (existing && constructionDigest(existing.content) === constructionDigest(content)) return NextResponse.json({ proposal: { id: existing.id }, reused: true });
    }
    if (error || !proposal) return NextResponse.json({ error: "Could not save variation draft." }, { status: 500 });
    return NextResponse.json({ proposal: { id: proposal.id } }, { status: 201 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
