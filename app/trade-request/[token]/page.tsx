import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isRequestFullyExpired } from "@/lib/trade-request";
import { ExpiredNotice } from "@/components/trade/ExpiredNotice";
import { TradeDocuments } from "@/components/trade/TradeDocuments";
import { TradeRequestLines, type TradeRequestLineView } from "@/components/trade-request/TradeRequestLines";
import { latestPlansFile, latestIssuedSow, findPresetNameForCategories, scheduleLabel, formatFileSize } from "@/lib/trade-doc-pack";
import type { TradeDocumentRow } from "@/types/trade-doc-pack";
import type { DocumentPackChoices } from "@/types/trade-doc-pack";
import type { SowDocument } from "@/types";

/**
 * /trade-request/[token] — public, unauthenticated grouped trade
 * request response page (BUILD-SPEC.md §"Grouped trade booking (r20)"
 * item 3). Mirrors app/trade/[token]/page.tsx's patterns exactly (same
 * file this round was told to study): token gate (trade_booking_
 * requests.token, an unguessable 32-byte hex string — same shape/
 * default as trade_visits.confirm_token), rate-limited, service-role
 * client (bypasses RLS — not an authenticated team session), noindex,
 * mobile-first, no login.
 *
 * MIDDLEWARE: lib/supabase/middleware.ts's isPublicPath allowlist
 * already covers this page and its API routes WITHOUT any edit —
 * `pathname.startsWith("/trade")` matches "/trade-request/..." too
 * (it's a plain string-prefix check, not a route-segment-aware match),
 * and `pathname.startsWith("/api/trade")` likewise matches
 * "/api/trade-request/..." — confirmed by reading that file (protected,
 * read-only for this round) before writing this page. No middleware
 * change needed, and none made.
 *
 * Expiry: BUILD-SPEC.md gives no single "end_date" for a multi-line
 * request the way a single r15 visit has — lib/trade-request.ts's
 * isRequestFullyExpired() is true only once EVERY non-deleted line has
 * passed its own end_date (a request with one line still upcoming
 * stays live). Re-checked independently by POST
 * /api/trade-request/[token]/respond too, same "a direct POST after
 * expiry can't succeed even if this page is bypassed" discipline as
 * the r15 flow.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function TradeRequestPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ preview?: string | string[] }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const isAdminPreview = query.preview === "1";

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-request-page:${token}:${clientIp}`);
  if (!limit.ok) {
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: bookingRequest } = await supabase
    .from("trade_booking_requests")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!bookingRequest) {
    notFound();
  }

  // Phase 3A delivery trail: a real token-page load is durable proof
  // that the booking link was reached. Admin previews explicitly use
  // ?preview=1 and do not contaminate this client-engagement evidence.
  if (!isAdminPreview && !bookingRequest.viewed_at) {
    await supabase
      .from("trade_booking_requests")
      .update({ viewed_at: new Date().toISOString() })
      .eq("id", bookingRequest.id)
      .is("viewed_at", null);
  }

  const [{ data: project }, { data: contact }, { data: lineRows }] = await Promise.all([
    supabase.from("projects").select("id,name,address").eq("id", bookingRequest.project_id).maybeSingle(),
    bookingRequest.contact_id
      ? supabase.from("contacts").select("id,company,contact_name").eq("id", bookingRequest.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from("trade_visits")
      .select("*")
      .eq("booking_request_id", bookingRequest.id)
      .is("deleted_at", null)
      .order("start_date", { ascending: true }),
  ]);

  if (!project) {
    notFound();
  }

  const lines = lineRows ?? [];

  if (isRequestFullyExpired(lines)) {
    return (
      <div className="min-h-screen bg-cream">
        <TradeRequestHeader />
        <main className="mx-auto max-w-md px-6 py-10">
          <ExpiredNotice />
        </main>
      </div>
    );
  }

  const { data: linkedTasks } = lines.length
    ? await supabase
        .from("board_tasks")
        .select("id,title,visit_id")
        .in(
          "visit_id",
          lines.map((l) => l.id)
        )
        .is("deleted_at", null)
    : { data: [] as { id: string; title: string; visit_id: string | null }[] };
  const taskTitleByVisitId = new Map((linkedTasks ?? []).map((t) => [t.visit_id, t.title]));

  const lineViews: TradeRequestLineView[] = lines.map((l) => ({
    id: l.id,
    task_title: taskTitleByVisitId.get(l.id) ?? "Site visit",
    start_date: l.start_date,
    end_date: l.end_date,
    line_status: (l.line_status as TradeRequestLineView["line_status"]) ?? "proposed",
    suggested_start: l.suggested_start,
    suggested_end: l.suggested_end,
    response_note: l.response_note,
  }));

  // ------------------------------------------------------------
  // DOCUMENTS section — same resolution as app/trade/[token]/page.tsx's
  // own (BUILD-SPEC.md item 2: "one document pack for the request,
  // reuse existing pack machinery"), read off the FIRST line's
  // document_pack (frozen identically onto every line at send time —
  // see POST /api/projects/[id]/trade-requests). Hrefs point at THIS
  // round's own /api/trade-request/[token]/documents/* proxies (which
  // themselves redirect to the existing r15 per-visit proxies — see
  // those routes' own doc comments), not directly at a visit token.
  // ------------------------------------------------------------
  const pack = (lines[0]?.document_pack ?? null) as DocumentPackChoices | null;
  const documentRows: TradeDocumentRow[] = [];

  if (pack) {
    const [{ data: plansFiles }, { data: sowRows }, { data: presetsRow }] = await Promise.all([
      pack.include_plans
        ? supabase
            .from("project_files")
            .select("id,storage_path,filename,revision_label,uploaded_at")
            .eq("project_id", project.id)
            .eq("kind", "plans")
            .is("deleted_at", null)
        : Promise.resolve({
            data: [] as { id: string; storage_path: string; filename: string; revision_label: string | null; uploaded_at: string }[],
          }),
      pack.include_sow
        ? supabase.from("sow_documents").select("*").eq("project_id", project.id).is("deleted_at", null)
        : Promise.resolve({ data: [] as SowDocument[] }),
      supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
    ]);

    if (pack.include_plans) {
      const latestPlans = latestPlansFile(plansFiles ?? []);
      if (latestPlans) {
        documentRows.push({
          kind: "plans",
          label: latestPlans.revision_label ? `Plans (${latestPlans.revision_label})` : "Plans",
          href: `/api/trade-request/${token}/documents/plans`,
        });
        try {
          const slash = latestPlans.storage_path.lastIndexOf("/");
          const dir = slash >= 0 ? latestPlans.storage_path.slice(0, slash) : "";
          const filename = slash >= 0 ? latestPlans.storage_path.slice(slash + 1) : latestPlans.storage_path;
          const { data: list } = await supabase.storage.from("assets").list(dir, { search: filename });
          const sizeBytes = list?.[0]?.metadata?.size;
          if (typeof sizeBytes === "number") {
            documentRows[documentRows.length - 1] = {
              ...documentRows[documentRows.length - 1],
              sizeLabel: formatFileSize(sizeBytes),
            };
          }
        } catch {
          // best-effort — no size label, row still renders.
        }
      }
    }

    if (pack.schedule_categories !== undefined) {
      const presets = (presetsRow?.value as { name: string; prefixes: string[] }[] | undefined) ?? [];
      const presetName = findPresetNameForCategories(pack.schedule_categories, presets);
      documentRows.push({
        kind: "schedule",
        label: scheduleLabel(pack.schedule_categories, presetName),
        href: `/api/trade-request/${token}/documents/schedule`,
      });
    }

    if (pack.include_sow) {
      const latestSow = latestIssuedSow((sowRows ?? []) as SowDocument[]);
      if (latestSow) {
        let sowLabel = `Scope of Works (${latestSow.revision_label})`;
        let sowHref = `/api/trade-request/${token}/documents/sow`;
        if (pack.include_sow_trade) {
          const { data: taggedSections } = await supabase
            .from("sow_sections")
            .select("id, sow_lines!inner(trade)")
            .eq("sow_id", latestSow.id)
            .eq("sow_lines.trade", pack.include_sow_trade)
            .limit(1);
          if ((taggedSections ?? []).length > 0) {
            sowLabel = `Scope of Works — ${pack.include_sow_trade} extract (${latestSow.revision_label})`;
            sowHref = `/api/trade-request/${token}/documents/sow?trade=${encodeURIComponent(pack.include_sow_trade)}`;
          }
        }
        documentRows.push({ kind: "sow", label: sowLabel, href: sowHref });
      }
    }
  }

  return (
    <div className="min-h-screen bg-cream">
      <TradeRequestHeader />
      <main className="mx-auto max-w-md px-6 py-8">
        <p className="label-caps">{project.name}</p>
        <h1 className="mt-1 font-display text-section text-nearblack">Site visit dates</h1>
        {project.address && <p className="mt-1 text-body text-charcoal/70">{project.address}</p>}
        {contact?.company && <p className="mt-1 text-body text-charcoal/70">{contact.company}</p>}

        {documentRows.length > 0 && (
          <div className="mt-6">
            <TradeDocuments rows={documentRows} />
          </div>
        )}

        <div className="mt-6">
          <TradeRequestLines token={token} lines={lineViews} />
        </div>
      </main>
      <footer className="mx-auto max-w-md px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}

function TradeRequestHeader() {
  return (
    <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
      <div className="mx-auto max-w-md">
        <Image src="/reslu-logo.png" alt="RESLU" width={130} height={57} priority className="h-12 w-auto" />
      </div>
    </header>
  );
}
