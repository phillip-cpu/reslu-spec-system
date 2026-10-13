import { constructionDigest as digest, constructionDraftId } from "@/lib/construction-proposal-identity";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { buildConstructionContent, constructionPrices } from "@/lib/construction-proposals";
import type { EstimateVersion } from "@/types/phase-12a-a";
import type { SowDocument, SowSectionWithLines } from "@/types";
import type { ConstructionSelection } from "@/types/construction-proposals";
export const runtime = "nodejs";

async function admin() {
  const db = await createClient();
  const user = await getUserRole(db);
  if (!user) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (user.role !== "admin") return { response: NextResponse.json({ error: "Only admins can generate construction proposals" }, { status: 403 }) };
  return { db };
}
async function sources(db: Awaited<ReturnType<typeof createClient>>, projectId: string, versionId: string, sowId: string) {
  const [{ data: version, error: ve }, { data: sow, error: se }] = await Promise.all([
    db.from("estimate_versions").select("*").eq("project_id", projectId).eq("id", versionId).maybeSingle(),
    db.from("sow_documents").select("*").eq("project_id", projectId).eq("id", sowId).is("deleted_at", null).maybeSingle(),
  ]);
  if (ve || se) throw new Error("Could not read proposal sources.");
  if (!version || !sow) throw new Error("Estimate version or scope not found for this project.");
  const { data, error } = await db.from("sow_sections").select("*, sow_lines(*)").eq("sow_id", sowId).order("sort").order("id");
  if (error) throw new Error("Could not read scope sections.");
  const sections: SowSectionWithLines[] = (data ?? []).map(s => ({ ...s, lines: [...s.sow_lines].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id)) }));
  return { version: version as EstimateVersion, sow: sow as SowDocument, sections, sourceDigest: digest({ version, sow, sections }) };
}
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await admin();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  try {
    const input = await sources(auth.db, id, request.nextUrl.searchParams.get("estimate_version_id") ?? "", request.nextUrl.searchParams.get("sow_id") ?? "");
    return NextResponse.json({ source_digest: input.sourceDigest, prices: constructionPrices(input.version), scope: input.sections.map(s => ({ id: s.id, heading: s.heading })) }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await admin();
  if ("response" in auth) return auth.response;
  const { id } = await params;
  const body = await request.json().catch(() => null) as (ConstructionSelection & { source_digest: string }) | null;
  if (!body || typeof body.estimate_version_id !== "string" || typeof body.sow_id !== "string" || typeof body.source_digest !== "string") return NextResponse.json({ error: "Select and review an estimate version and issued scope first." }, { status: 400 });
  try {
    const input = await sources(auth.db, id, body.estimate_version_id, body.sow_id);
    if (body.source_digest !== input.sourceDigest) return NextResponse.json({ error: "Source changed while you were reviewing. Reload before generating." }, { status: 409 });
    let previous;
    if (body.previous_proposal_id) {
      const { data, error } = await auth.db.from("proposals").select("*").eq("id", body.previous_proposal_id).eq("project_id", id).maybeSingle();
      if (error || !data) return NextResponse.json({ error: "Previous proposal not found for this project." }, { status: 404 });
      previous = data;
    }
    const content = buildConstructionContent({ ...input, selection: body, previous });
    // Content-addressed row identity: repeated clicks, network retries, and concurrent
    // tabs with the same sources/choices converge on one frozen draft. No upsert.
    const proposalId = constructionDraftId(id, content);
    const { data: proposal, error } = await auth.db.from("proposals").insert({
      id: proposalId, project_id: id, lead_id: null, status: "draft", content,
      total_inc: content.construction.total_inc,
      deposit_inc: content.construction.payments[0].amount_inc,
    }).select().single();
    if (error?.code === "23505") {
      const { data: existing } = await auth.db.from("proposals").select("id,content").eq("id", proposalId).eq("project_id", id).maybeSingle();
      if (existing && digest(existing.content) === digest(content)) return NextResponse.json({ proposal: { id: existing.id }, reused: true });
    }
    if (error || !proposal) return NextResponse.json({ error: "Could not save construction draft." }, { status: 500 });
    return NextResponse.json({ proposal: { id: proposal.id }, reused: false }, { status: 201 });
  } catch (e) { return NextResponse.json({ error: (e as Error).message }, { status: 400 }); }
}
