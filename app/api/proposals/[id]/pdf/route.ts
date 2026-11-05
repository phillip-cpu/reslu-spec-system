import { isConstructionQuote, quoteContent } from "@/lib/construction-quotes";
import { NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ProposalPdf } from "@/components/pdf/ProposalPdf";
import { isConstruction } from "@/lib/construction-proposals";
export const runtime = "nodejs";
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const db = await createClient();
  const user = await getUserRole(db);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  const { id } = await params;
  const { data: proposal } = await db.from("proposals").select("*").eq("id", id).maybeSingle();
  if (!proposal || (!isConstruction(proposal.content) && !isConstructionQuote(proposal.content))) return NextResponse.json({ error: "Construction proposal not found" }, { status: 404 });
  if (isConstructionQuote(proposal.content)) {
    try { proposal.content = quoteContent(proposal.content.quote); proposal.total_inc = proposal.content.fees.stages[0].total_inc; proposal.deposit_inc = 0; } catch { return NextResponse.json({ error: "Invalid quote" }, { status: 409 }); }
  }
  const { data: project } = await db.from("projects").select("name,alias,address,client_name").eq("id", proposal.project_id).single();
  const bytes = await renderToBuffer(ProposalPdf({ proposal, residence: project?.alias || project?.name || "Project", address: project?.address ?? null, clientName: project?.client_name || "Client", coverDateLabel: new Date(proposal.created_at).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "Australia/Adelaide" }), signedDateLabel: "" }));
  return new NextResponse(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="construction-${id}.pdf"`, "Cache-Control": "private, no-store" } });
}
