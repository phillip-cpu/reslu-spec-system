import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { isVisitExpired, findOverlappingVisits, formatArrival } from "@/lib/trade-visits";
import { ExpiredNotice } from "@/components/trade/ExpiredNotice";
import { WhoElseOnSite } from "@/components/trade/WhoElseOnSite";
import { TradeRespondForm } from "@/components/trade/TradeRespondForm";
import { TradeDocuments } from "@/components/trade/TradeDocuments";
import { latestPlansFile, latestIssuedSow, findPresetNameForCategories, scheduleLabel, formatFileSize } from "@/lib/trade-doc-pack";
import type { TradeDocumentRow } from "@/types/trade-doc-pack";
import type { SowDocument } from "@/types";

/**
 * /trade/[token] — public, unauthenticated trade confirmation page
 * (Phase 11A / BUILD-SPEC.md "Trade confirmation engine"). Same trust
 * model as /portal/[token]: an unguessable 32-byte token
 * (trade_visits.confirm_token) is the security boundary, not a hidden
 * route. Rate-limited by IP, noindex, service-role client (bypasses
 * RLS — this route is NOT an authenticated team session).
 *
 * MIDDLEWARE NOTE (corrected — 8 July 2026, "Trade booking document
 * pack" round): a prior version of this comment flagged
 * `/trade`/`/api/trade` as MISSING from lib/supabase/middleware.ts's
 * isPublicPath allowlist. Re-checked against that file (still
 * protected/read-only for this agent, but readable) as part of this
 * round's own token-gating verification pass: both prefixes are
 * ALREADY present (`pathname.startsWith("/trade")` and
 * `pathname.startsWith("/api/trade")`, added since that original doc
 * comment was written) — this page and every /api/trade/[token]/**
 * route (including this round's new .../documents/plans|schedule|sow
 * proxies) are correctly public today. No on-machine follow-up needed
 * for middleware; left as a plain historical note rather than deleted
 * outright so a future reader isn't left wondering whether the
 * allowlist was ever actually fixed.
 *
 * Expiry: a visit's link is expired if deleted_at is set OR
 * today > end_date (date-only comparison, lib/trade-visits.ts's
 * isVisitExpired — the same helper the respond route re-checks
 * independently, so a direct POST after expiry can't succeed even if
 * this page is bypassed). Renders via notFound(), consistent with how
 * /portal/[token]/sign/[requestId]/page.tsx signals "nothing here" for
 * an invalid/expired signing link.
 *
 * No contact phone/email of ANY trade (self or others) is ever fetched
 * into this page's render path — only company/contact_name for self,
 * and company + status for the "who else is on site" list.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function TradePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-page:${token}:${clientIp}`);
  if (!limit.ok) {
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: visit } = await supabase
    .from("trade_visits")
    .select("*")
    .eq("confirm_token", token)
    .maybeSingle();

  if (!visit) {
    notFound();
  }

  if (isVisitExpired(visit)) {
    return (
      <div className="min-h-screen bg-cream">
        <TradeHeader />
        <main className="mx-auto max-w-md px-6 py-10">
          <ExpiredNotice />
        </main>
      </div>
    );
  }

  const [{ data: phase }, { data: project }, { data: contact }] = await Promise.all([
    supabase.from("schedule_phases").select("id,name,project_id").eq("id", visit.phase_id).maybeSingle(),
    supabase.from("projects").select("id,name,client_name").eq("id", visit.project_id).maybeSingle(),
    visit.contact_id
      ? supabase.from("contacts").select("id,company,contact_name").eq("id", visit.contact_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  if (!phase || !project) {
    notFound();
  }

  // "Who else is on site" — other non-deleted, confirmed/tentative
  // visits in the same project whose date range overlaps this visit's
  // covered week(s). Company + status ONLY, never contact_name/phone/
  // email of the other trade.
  const { data: otherVisitsRaw } = await supabase
    .from("trade_visits")
    .select("id,start_date,end_date,status,deleted_at,contact_id")
    .eq("project_id", project.id)
    .neq("id", visit.id);

  const overlapping = findOverlappingVisits(
    { id: visit.id, start_date: visit.start_date, end_date: visit.end_date, status: visit.status, deleted_at: visit.deleted_at },
    (otherVisitsRaw ?? []).map((v) => ({
      id: v.id,
      start_date: v.start_date,
      end_date: v.end_date,
      status: v.status,
      deleted_at: v.deleted_at,
    }))
  ).filter((v) => v.status === "confirmed" || v.status === "tentative");

  const otherContactIds = [
    ...new Set(
      (otherVisitsRaw ?? [])
        .filter((v) => overlapping.some((o) => o.id === v.id))
        .map((v) => v.contact_id)
        .filter(Boolean)
    ),
  ] as string[];

  const { data: otherContacts } = otherContactIds.length
    ? await supabase.from("contacts").select("id,company").in("id", otherContactIds)
    : { data: [] as { id: string; company: string }[] };
  const otherContactCompanyById = new Map((otherContacts ?? []).map((c) => [c.id, c.company]));
  const otherContactIdByVisitId = new Map((otherVisitsRaw ?? []).map((v) => [v.id, v.contact_id]));

  const whoElse = overlapping.map((v) => {
    const contactId = otherContactIdByVisitId.get(v.id);
    return {
      company: contactId ? otherContactCompanyById.get(contactId) ?? "Trade" : "Trade",
      status: v.status,
    };
  });

  // ------------------------------------------------------------
  // "Trade booking document pack" round — DOCUMENTS section (BUILD-
  // SPEC.md item 3). Resolved fresh on every render from
  // visit.document_pack's FROZEN choices against the project's
  // CURRENT live documents — see lib/trade-doc-pack.ts's header
  // comment for the full "frozen choices, live revisions" rationale.
  // A visit with document_pack === null (every visit created before
  // this round, or one whose panel never configured a pack) renders
  // NOTHING here — documentRows stays empty and TradeDocuments itself
  // no-ops on an empty array, same as WhoElseOnSite's own "render
  // nothing if there's nothing to show" convention above.
  // ------------------------------------------------------------
  const pack = visit.document_pack as {
    include_plans: boolean;
    // Optional — key ABSENCE means "Schedule unticked," distinct from
    // `null` ("Schedule ticked, full schedule") — see
    // types/trade-doc-pack.ts's DocumentPackChoices for the full
    // three-state encoding this cast mirrors.
    schedule_categories?: string[] | null;
    include_sow: boolean;
    // "Trade-scoped SOW extracts" round — optional on this cast (not
    // required) purely so this page still renders correctly against
    // pre-round rows written before this field existed (column value
    // simply undefined on old jsonb, same as any other new key added
    // to a jsonb blob after rows already exist) — types/trade-doc-
    // pack.ts's own DocumentPackChoices interface still declares it as
    // always-present for every NEW pack, this cast is just defensive
    // about OLD ones.
    include_sow_trade?: string | null;
  } | null;

  const documentRows: TradeDocumentRow[] = [];

  if (pack) {
    // Service-role reads throughout (same trust boundary as everything
    // else on this page) — the export presets lookup queries
    // app_settings directly (mirrors GET /api/settings/export-presets'
    // own query) rather than fetching that route over HTTP, since that
    // route requires an authenticated team session this public,
    // token-gated page never has.
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
      supabase.from("sow_documents").select("*").eq("project_id", project.id).is("deleted_at", null),
      supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
    ]);

    if (pack.include_plans) {
      const latestPlans = latestPlansFile(plansFiles ?? []);
      if (latestPlans) {
        documentRows.push({
          kind: "plans",
          label: latestPlans.revision_label ? `Plans (${latestPlans.revision_label})` : "Plans",
          href: `/api/trade/${token}/documents/plans`,
        });

        // File size (a real Storage object — cheap to read via list();
        // the schedule/SOW rows are generated PDFs with no stored size
        // to read without rendering them, per BUILD-SPEC's own "file
        // sizes where cheap" wording). Best-effort — any failure here
        // just omits the size label, the row above still renders.
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
      // No `else` — a pack that ticked Plans at booking time but has
      // since had every plans revision removed simply omits this row,
      // per this round's own "never a broken link" resolution rule.
    }

    if (pack.schedule_categories !== undefined) {
      // Label-only lookup — findPresetNameForCategories(..., []) always
      // returns null when there are no presets to match, identical to
      // "no match found," so a missing/empty app_settings row never
      // blocks the row itself, just falls back to "Custom"/"Full
      // schedule."
      const presets = (presetsRow?.value as { name: string; prefixes: string[] }[] | undefined) ?? [];
      const presetName = findPresetNameForCategories(pack.schedule_categories, presets);
      documentRows.push({
        kind: "schedule",
        label: scheduleLabel(pack.schedule_categories, presetName),
        href: `/api/trade/${token}/documents/schedule`,
      });
    }

    if (pack.include_sow) {
      const latestSow = latestIssuedSow((sowRows ?? []) as SowDocument[]);
      if (latestSow) {
        // "Trade-scoped SOW extracts" round — prefer the booked
        // trade's extract over the full document, but ONLY when that
        // trade CURRENTLY has at least one tagged line in THIS latest
        // issued revision (re-checked fresh here, every render — the
        // pack only froze the DECISION "prefer this trade," never
        // whether it has anything tagged; see
        // types/trade-doc-pack.ts's `include_sow_trade` doc comment).
        // No tagged lines (or no trade preference at all) falls back
        // to the full SOW, unchanged from this round's starting
        // behaviour.
        let sowLabel = `Scope of Works (${latestSow.revision_label})`;
        let sowHref = `/api/trade/${token}/documents/sow`;
        if (pack.include_sow_trade) {
          const { data: taggedSections } = await supabase
            .from("sow_sections")
            .select("id, sow_lines!inner(trade)")
            .eq("sow_id", latestSow.id)
            .eq("sow_lines.trade", pack.include_sow_trade)
            .limit(1);
          if ((taggedSections ?? []).length > 0) {
            sowLabel = `Scope of Works — ${pack.include_sow_trade} extract (${latestSow.revision_label})`;
            sowHref = `/api/trade/${token}/documents/sow?trade=${encodeURIComponent(pack.include_sow_trade)}`;
          }
        }
        documentRows.push({ kind: "sow", label: sowLabel, href: sowHref });
      }
    }
  }

  return (
    <div className="min-h-screen bg-cream">
      <TradeHeader />
      <main className="mx-auto max-w-md px-6 py-8">
        <p className="label-caps">{project.name}</p>
        <h1 className="mt-1 font-display text-section text-nearblack">{phase.name}</h1>
        {contact?.company && <p className="mt-1 text-body text-charcoal/70">{contact.company}</p>}

        <div className="mt-6 border border-[#dcd6cc] bg-offwhite px-4 py-4">
          <p className="label-caps">Nominated day{visit.start_date !== visit.end_date ? "s" : ""}</p>
          <p className="mt-1 text-body text-nearblack">
            {visit.start_date}
            {visit.start_date !== visit.end_date ? ` → ${visit.end_date}` : ""}
          </p>
          <p className="mt-2 label-caps">Arrival</p>
          <p className="mt-1 text-body text-nearblack">{formatArrival(visit.arrival_slot, visit.arrival_time)}</p>
          {visit.status === "proposed_change" && visit.proposed_start && (
            <div className="mt-3 border-t border-[#dcd6cc] pt-3">
              <p className="label-caps">We&apos;ve proposed a different date</p>
              <p className="mt-1 text-body text-nearblack">
                {visit.proposed_start}
                {visit.proposed_end !== visit.proposed_start ? ` → ${visit.proposed_end}` : ""} —{" "}
                {formatArrival(visit.proposed_slot, visit.proposed_time)}
              </p>
              {visit.proposed_note && <p className="mt-1 text-caption text-charcoal/60">{visit.proposed_note}</p>}
            </div>
          )}
        </div>

        {whoElse.length > 0 && (
          <div className="mt-6">
            <WhoElseOnSite entries={whoElse} />
          </div>
        )}

        {documentRows.length > 0 && (
          <div className="mt-6">
            <TradeDocuments rows={documentRows} />
          </div>
        )}

        <div className="mt-8">
          <TradeRespondForm
            token={token}
            hasArrival={Boolean(visit.arrival_slot || visit.arrival_time)}
            currentStatus={visit.status}
          />
        </div>
      </main>
      <footer className="mx-auto max-w-md px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}

function TradeHeader() {
  return (
    <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
      <div className="mx-auto max-w-md">
        <Image src="/reslu-logo.png" alt="RESLU" width={130} height={57} priority className="h-12 w-auto" />
      </div>
    </header>
  );
}
