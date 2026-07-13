import type { Metadata } from "next";
import Image from "next/image";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { residenceLabel } from "@/lib/proposals";
import { TIMELINE_COUNCIL_CAVEAT } from "@/lib/proposal-templates";
import { ProposalSignForm } from "@/components/proposal/ProposalSignForm";
import { ProposalReveal } from "@/components/proposal/ProposalReveal";
import type { Proposal, ProposalContent } from "@/types/proposals";

/**
 * /proposal/[token] — public, unauthenticated fee-proposal document +
 * sign-to-accept page (BUILD-SPEC.md §"Fee proposal phase (r23)" item
 * 4). Mirrors app/trade-request/[token]/page.tsx / app/brief/[token]'s
 * own patterns exactly (the round's own "study first" list): token
 * gate (proposals.token, same unguessable 32-byte hex shape as every
 * other tokened surface in this schema), rate-limited, service-role
 * client (bypasses RLS — unauthenticated by session), noindex,
 * mobile-first, real logo, no login.
 *
 * This SAME page is also the Builder UI's own "Live preview" link
 * (reachable before Send, while status='draft') — see migration 051's
 * own column comment on `viewed_at` for why a draft-status visit never
 * sets it.
 *
 * MIDDLEWARE: no existing `isPublicPath` prefix in
 * lib/supabase/middleware.ts covers `/proposal` or `/api/proposal`
 * (protected/read-only for this round — confirmed by reading that file
 * before writing this page, NOT edited). Claude Code: add, boundary-
 * aware (a bare startsWith("/proposal") would also match the
 * admin-only /proposals/[id] editor route), alongside the existing
 * /brief and /trade-request lines in isPublicPath:
 *
 *   pathname === "/proposal" ||
 *   pathname.startsWith("/proposal/") ||
 *   pathname.startsWith("/api/proposal/") ||
 *
 * Without these, this page and POST /api/proposal/[token]/accept both
 * redirect to /login (or 401) before they ever run — see docs/API.md's
 * "Fee proposal phase" section and README.md's own install-step
 * writeup for the same lines.
 */
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number.isFinite(value) ? value : 0);
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
}

/** No markdown renderer exists in this repo, and this round is told not
 * to add one (docs/proposal-reference-content.md's terms are plain text
 * with ALL-CAPS headings, blank-line-separated paragraphs) — split on
 * blank lines and render as preformatted paragraphs, same approach as
 * components/pdf/ProposalPdf.tsx's splitTermsParagraphs(). */
function TermsBody({ md }: { md: string }) {
  const paragraphs = md
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  return (
    <div className="space-y-3">
      {paragraphs.map((p, i) => {
        const isHeading = p.length < 60 && p === p.toUpperCase() && /[A-Z]/.test(p) && !p.includes(".");
        return isHeading ? (
          <p key={i} className="label-caps mt-4">
            {p}
          </p>
        ) : (
          <p key={i} className="text-body text-charcoal/80">
            {p}
          </p>
        );
      })}
    </div>
  );
}

export default async function ProposalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`proposal-page:${token}:${clientIp}`);
  if (!limit.ok) {
    notFound();
  }

  const supabase = createServiceRoleClient();

  const { data: proposal } = await supabase
    .from("proposals")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (!proposal) {
    notFound();
  }
  const p = proposal as Proposal;
  const content = p.content as ProposalContent;

  const [{ data: lead }, { data: project }] = await Promise.all([
    p.lead_id
      ? supabase.from("leads").select("id,first_name,surname_project,location").eq("id", p.lead_id).maybeSingle()
      : Promise.resolve({ data: null }),
    p.project_id
      ? // r25 adds client_name to this select — same "greeting name" field
        // app/api/proposals/[id]/{send,resend}/route.ts already read off
        // project for the email's {{company}} pen name; the page reveal's
        // packet (components/proposal/ProposalReveal.tsx) writes the same
        // value so the emailed packet and the page packet always agree.
        supabase.from("projects").select("id,name,alias,address,client_name").eq("id", p.project_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const residence = residenceLabel({ lead, project });
  const address = project?.address ?? lead?.location ?? null;
  // Same precedence as the send/resend routes' own greetingName — kept
  // in sync deliberately (see the select() comment above).
  const greetingName = project?.client_name || lead?.first_name || lead?.surname_project || "there";
  const sentDateLabel = p.sent_at ? formatDate(p.sent_at) : formatDate(p.created_at);

  // viewed_at: set once, only while status='sent', only if still null —
  // migration 051's own column comment. A draft-status "Live preview"
  // visit from the Builder UI never sets this.
  if (p.status === "sent" && !p.viewed_at) {
    await supabase.from("proposals").update({ viewed_at: new Date().toISOString() }).eq("id", p.id);
  }

  return (
    <div className="min-h-screen bg-cream">
      <header className="border-b border-[#dcd6cc] bg-cream px-6 py-8">
        <div className="mx-auto max-w-2xl">
          <Image src="/reslu-logo.png" alt="RESLU" width={130} height={57} priority className="h-12 w-auto" />
        </div>
      </header>

      {/* r25 "Proposal delivery skin" — ProposalReveal is a client
       * component; this whole <main> document is passed through as its
       * `children`, so it stays a Server Component render (same data,
       * same JSX below, completely unchanged) — ProposalReveal only
       * toggles visibility/opacity around it and layers the filmed-
       * unfold overlay on top. See that component's own header comment
       * for the full beat 1/2/3 sequence and fallback matrix. r25.2:
       * no more `heading` prop — the on-sheet landing layer it fed is
       * gone, ProposalReveal now sizes/positions THIS <main> directly
       * (via its `.pr-doc` wrapper) off the same sheet geometry the
       * video uses, so the real document is always the thing on screen,
       * never a second approximation of it. */}
      <ProposalReveal token={token} greetingName={greetingName} sentDateLabel={sentDateLabel} residence={residence}>
        <main className="mx-auto max-w-2xl px-6 py-10">
        {p.status === "draft" && (
          <p className="mb-6 border border-sand/60 bg-offwhite px-4 py-2 text-caption text-sand">
            Preview — this proposal has not been sent yet.
          </p>
        )}

        <p className="label-caps">Design Proposal</p>
        <h1 className="mt-1 font-display text-section text-nearblack">{residence}</h1>
        {address && <p className="mt-1 text-body text-charcoal/70">{address}</p>}
        <p className="mt-1 text-caption text-charcoal/40">{sentDateLabel}</p>

        {/* Letter */}
        <section className="mt-10">
          <p className="label-caps mb-3">Letter</p>
          <div className="space-y-3">
            {content.letter.split(/\n\s*\n/).map((para, i) => (
              <p key={i} className="text-body text-charcoal/80 whitespace-pre-line">
                {para}
              </p>
            ))}
          </div>
        </section>

        {/* Vision */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-3">Project Vision Alignment</p>
          <div className="space-y-3">
            {content.vision.split(/\n\s*\n/).map((para, i) => (
              <p key={i} className="text-body text-charcoal/80 whitespace-pre-line">
                {para}
              </p>
            ))}
          </div>
        </section>

        {/* Scope */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-4">Scope of Design Services</p>
          <div className="space-y-8">
            {content.scope_sections.map((section, i) => (
              <div key={i}>
                <h3 className="font-display text-subhead text-nearblack" style={{ fontSize: "18px" }}>
                  {section.title}
                </h3>
                {section.intro && <p className="mt-2 text-body text-charcoal/80">{section.intro}</p>}
                <ul className="mt-3 space-y-1.5">
                  {section.bullets.map((b, bi) => (
                    <li key={bi} className="flex gap-2 text-body text-charcoal/80">
                      <span className="text-sand">—</span>
                      <span>{b}</span>
                    </li>
                  ))}
                </ul>
                {section.deliverables.length > 0 && (
                  <div className="mt-3">
                    <p className="label-caps mb-1.5">Deliverables</p>
                    <ul className="space-y-1">
                      {section.deliverables.map((d, di) => (
                        <li key={di} className="flex gap-2 text-body text-charcoal/70">
                          <span className="text-sand">→</span>
                          <span>{d}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Fees */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-4">Design Fee &amp; Payment Structure</p>
          <div className="space-y-6">
            {content.fees.stages.map((stage, si) => (
              <div key={si}>
                <div className="flex items-baseline justify-between border-b border-nearblack pb-1.5">
                  <p className="text-subhead text-nearblack">{stage.label}</p>
                  <p className="text-subhead text-nearblack">{formatMoney(stage.total_inc)} Inc GST</p>
                </div>
                <ul className="mt-2 space-y-1">
                  {stage.milestones.map((m, mi) => (
                    <li key={mi} className="flex items-baseline justify-between text-body text-charcoal/80">
                      <span>{m.label}</span>
                      <span>{formatMoney(m.amount_inc)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {content.fees.payment_lines.length > 0 && (
              <div>
                <p className="label-caps mb-1.5">Payment Structure</p>
                <ul className="space-y-1">
                  {content.fees.payment_lines.map((line, li) => (
                    <li key={li} className="flex gap-2 text-body text-charcoal/80">
                      <span className="text-sand">—</span>
                      <span>{line}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="border-t border-nearblack pt-3">
              <div className="flex items-baseline justify-between">
                <p className="text-subhead text-nearblack">Total design fee (inc GST)</p>
                <p className="text-subhead text-nearblack">{formatMoney(p.total_inc)}</p>
              </div>
              <div className="mt-1 flex items-baseline justify-between">
                <p className="text-body text-sand">Deposit payable on acceptance</p>
                <p className="text-body text-sand">{formatMoney(p.deposit_inc)}</p>
              </div>
            </div>
          </div>
        </section>

        {/* Timeline */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-4">Project Timeline</p>
          <table className="w-full text-body text-charcoal/80">
            <tbody>
              {content.timeline.map((row, ti) => (
                <tr key={ti} className="border-b border-[#dcd6cc]">
                  <td className="py-2 pr-3">{row.phase}</td>
                  <td className="py-2 text-right">{row.duration}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-caption italic text-charcoal/50">{TIMELINE_COUNCIL_CAVEAT}</p>
        </section>

        {/* Exclusions */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-4">Exclusions &amp; Additional Consultant Services</p>
          <ul className="space-y-1.5">
            {content.exclusions.bullets.map((b, bi) => (
              <li key={bi} className="flex gap-2 text-body text-charcoal/80">
                <span className="text-sand">—</span>
                <span>{b}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 border border-[#dcd6cc] bg-offwhite p-4">
            <p className="text-body text-charcoal/80">{content.exclusions.allowance}</p>
          </div>
        </section>

        {/* Terms — inline, always open (Phillip 2026-07-12: whole document scrolls, nothing behind tabs) */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <h2 className="label-caps">Terms</h2>
          <div className="mt-4">
            <TermsBody md={content.terms_md} />
          </div>
        </section>

        {/* Sign to accept */}
        <section className="mt-10 border-t border-[#dcd6cc] pt-8">
          <p className="label-caps mb-4">Sign to Accept</p>
          {p.status === "accepted" ? (
            <div className="border border-sand bg-offwhite p-6 text-center">
              <p className="text-subhead text-nearblack">
                Signed by {p.signed_name} on {formatDate(p.signed_at)}.
              </p>
            </div>
          ) : p.status === "sent" ? (
            <ProposalSignForm token={token} />
          ) : (
            <p className="border border-[#dcd6cc] bg-offwhite p-6 text-center text-body text-charcoal/60">
              {p.status === "draft"
                ? "This proposal hasn't been sent for signing yet."
                : "This proposal is no longer available for signing."}
            </p>
          )}
        </section>
        </main>
      </ProposalReveal>

      <footer className="mx-auto max-w-2xl px-6 py-10 text-caption text-charcoal/40">
        RESLU · This is a private link. Please don&apos;t share it.
      </footer>
    </div>
  );
}
