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

/**
 * /trade/[token] — public, unauthenticated trade confirmation page
 * (Phase 11A / BUILD-SPEC.md "Trade confirmation engine"). Same trust
 * model as /portal/[token]: an unguessable 32-byte token
 * (trade_visits.confirm_token) is the security boundary, not a hidden
 * route. Rate-limited by IP, noindex, service-role client (bypasses
 * RLS — this route is NOT an authenticated team session).
 *
 * IMPORTANT — on-machine follow-up required: this path is not yet in
 * lib/supabase/middleware.ts's isPublicPath allowlist (that file is
 * protected/read-only for this agent). Until a human adds
 * `pathname.startsWith("/trade")` (and `/api/trade`) to that allowlist,
 * an unauthenticated visitor hitting this page gets redirected to
 * /login instead of reaching this page. See the final build report for
 * the exact lines to add.
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
