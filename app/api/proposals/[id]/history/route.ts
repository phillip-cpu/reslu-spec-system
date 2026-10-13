import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { isConstruction } from "@/lib/construction-proposals";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await createClient(); const user = await getUserRole(db);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  const { id } = await params;
  const { data: p } = await db.from("proposals").select("id,project_id,content").eq("id",id).maybeSingle();
  if (!p || !isConstruction(p.content)) return NextResponse.json({ error: "Construction proposal not found" }, { status: 404 });
  const { data, error } = await createServiceRoleClient().rpc("construction_proposal_history", { p_project: p.project_id, p_proposal: p.id });
  if (error) return NextResponse.json({ error: "Database approval history is unavailable until the reviewed migration is installed." }, { status: 503 });
  return NextResponse.json({ events: data }, { headers: { "Cache-Control": "private, no-store" } });
}
