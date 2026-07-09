import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { renderToBuffer } from "@react-pdf/renderer";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired } from "@/lib/trade-visits";
import { latestIssuedSow } from "@/lib/trade-doc-pack";
import { filterSectionsForTrade } from "@/lib/sow-trade-tags";
import { SowPdf } from "@/components/pdf/SowPdf";
import type { SowDocument } from "@/types";
import type { SowSectionWithTradedLines } from "@/types/sow-trade-tags";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/trade/[token]/documents/sow
 *
 * Tokened proxy for a trade's booking-page Scope of Works PDF (BUILD-
 * SPEC.md "Trade booking document pack" item 3) — renders the SAME
 * branded SOW PDF GET /api/projects/[id]/sow/[sowId]/pdf produces for
 * the team, for the project's CURRENT latest ISSUED revision (resolved
 * fresh every request — see lib/trade-doc-pack.ts's header comment for
 * the full "frozen choices, live revisions" reasoning: a booking's
 * pack only freezes the DECISION "include the SOW," never which
 * revision — a newer issued revision automatically supersedes an older
 * one the trade already saw, with no re-booking needed).
 *
 * No caching here, matching the team-facing SOW PDF route's own
 * behaviour (that route renders fresh on every request too — SOW
 * documents are typically opened far less often than the FF&E
 * schedule, so this round does not introduce a caching layer that
 * route's own author didn't judge necessary).
 *
 * TOKEN GATING — identical shape to the plans/schedule proxies: rate
 * limited by token+IP, confirm_token must resolve to a real
 * non-deleted visit, isVisitExpired() re-checked independently,
 * document_pack.include_sow must be true.
 *
 * "Trade-scoped SOW extracts" round — doc-pack integration: optional
 * `?trade=<preset name>`, passed by the trade page (see that page's
 * own DOCUMENTS-section doc comment) whenever the visit's frozen
 * `document_pack.include_sow_trade` names a trade that CURRENTLY has
 * >=1 tagged line in the latest issued SOW — same "frozen choice, live
 * revisions" re-resolution the page already does for plans/schedule.
 * This route itself does no re-validation of that decision (the page
 * already re-checked freshly before building this href) — it simply
 * renders whichever extract (or full SOW, if `trade` is absent) the
 * query asks for, via the SAME filterSectionsForTrade() the team-facing
 * PDF route uses, so the two extracts can never drift on composition.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const trade = request.nextUrl.searchParams.get("trade")?.trim() || null;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-doc-sow:${token}:${clientIp}`);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("id,project_id,end_date,deleted_at,document_pack")
    .eq("confirm_token", token)
    .maybeSingle();
  if (!visit) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (isVisitExpired(visit)) {
    return NextResponse.json({ error: "This link has expired." }, { status: 410 });
  }

  const pack = visit.document_pack as { include_sow?: boolean } | null;
  if (!pack?.include_sow) {
    return NextResponse.json({ error: "No scope of works was included with this booking." }, { status: 404 });
  }

  const { data: sowRows } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("project_id", visit.project_id)
    .is("deleted_at", null);

  const latest = latestIssuedSow((sowRows ?? []) as SowDocument[]);
  if (!latest) {
    return NextResponse.json({ error: "No issued scope of works is currently available for this project." }, { status: 404 });
  }

  const [{ data: project }, { data: sections, error: sectionsError }] = await Promise.all([
    supabase.from("projects").select("id,name,client_name,address,job_number").eq("id", visit.project_id).single(),
    supabase.from("sow_sections").select("*, sow_lines(*)").eq("sow_id", latest.id).order("sort", { ascending: true }),
  ]);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  const sectionsWithLines: SowSectionWithTradedLines[] = (sections ?? []).map((section) => {
    const lines = (
      (section as unknown as { sow_lines: SowSectionWithTradedLines["lines"] }).sow_lines ?? []
    ).sort((a, b) => a.sort - b.sort);
    const { sow_lines: _omit, ...rest } = section as unknown as Record<string, unknown>;
    void _omit;
    return { ...(rest as unknown as SowSectionWithTradedLines), lines };
  });

  // "Trade-scoped SOW extracts" — same filter the team-facing PDF
  // route uses, keyed off the query string this route's own doc
  // comment above describes.
  const renderedSections = trade ? filterSectionsForTrade(sectionsWithLines, trade) : sectionsWithLines;

  const generatedAt = new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  const projectNo = project.job_number ?? (visit.project_id as string).slice(0, 8).toUpperCase();

  let buffer: Buffer;
  try {
    buffer = await renderToBuffer(
      SowPdf({
        project,
        sections: renderedSections,
        revisionLabel: latest.revision_label,
        status: latest.status,
        issuedAt: latest.issued_at,
        projectNo,
        generatedAt,
        extractTrade: trade,
      })
    );
  } catch (err) {
    console.error("trade documents/sow: render failed", err);
    return NextResponse.json({ error: "Could not generate the scope of works. Please try again." }, { status: 500 });
  }

  const filename = trade
    ? `${project.name.replace(/[^a-z0-9]+/gi, "-")}-SOW-${latest.revision_label}-${trade.replace(/[^a-z0-9]+/gi, "-")}.pdf`
    : `${project.name.replace(/[^a-z0-9]+/gi, "-")}-SOW-${latest.revision_label}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
