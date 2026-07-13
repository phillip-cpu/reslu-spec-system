// ============================================================
// RESLU Spec System — Daily Brief generator (Phillip, 8 July 2026,
// migration 041). Pure, dependency-free helpers — no Supabase/Next
// imports, plain data in/out — mirroring lib/order-by.ts's /
// lib/board-cockpit.ts's / lib/leads.ts's exact shape so title
// wording, deep links, and dedupe logic can never drift between
// POST /api/brief/generate (the only caller today) and any future
// caller (a preview endpoint, a test).
//
// BUILD-SPEC.md "Daily Brief": "morning cron ... aggregates the
// existing attention feeds (due bookings, ordering_due, lead
// nurture/stale, trade proposals, expiring insurance) into brief
// items (dedupe: don't recreate an open item with same source+link;
// carried-over items get a subtle 'from yesterday' tag)."
//
// GENERATOR SEMANTICS (documented here once, referenced from the
// route): each of the five source feeds below is turned into
// candidate DailyBriefCandidate rows. For each candidate, the caller
// (the route) checks whether an OPEN daily_brief_items row already
// exists with the SAME (source, link_href) within the last 7 days
// (dedupeCandidates() below) — if so, the candidate is skipped
// entirely (not re-inserted, not updated); if not, it is inserted with
// today's brief_date. This makes the generator naturally idempotent —
// running it twice in one day (or being re-triggered by a manual
// "Send now" test) produces zero duplicate rows, because every
// candidate it would produce the second time already has a matching
// open row from the first run. An item that was never re-ticked stays
// "open" indefinitely across days without ever being recreated — the
// SAME row simply keeps showing up on every subsequent GET /api/brief
// call (which queries ALL open items regardless of brief_date, not
// just today's — see that route's own doc comment), tagged with a
// "from {weekday}" label computed by carriedOverLabel() below from how
// many days old its brief_date is. Once a human ticks it done
// (PATCH .../[id] -> status 'done'), the dedupe check on the next
// generator run no longer finds an open match, so a fresh occurrence
// of the same underlying condition (e.g. the booking is STILL
// unconfirmed a week later) creates a brand new item — the brief never
// silently "resolves itself" just because 7 days passed; the 7-day
// window only bounds how far back the dedupe LOOKUP searches, it does
// not expire/auto-close anything.
// ============================================================

// QA fix round (r27) item 14 — "proposal" was added to the DB's own
// daily_brief_items.source CHECK constraint by migration 051 (fee
// proposal phase, r23 — POST /api/proposal/[token]/accept's own
// "Proposal accepted — {residence}" attention row) but never added
// HERE, the actual TS source-of-truth union every SOURCE_LABEL Record
// below is keyed off — the exact same "schema widened, TS type left
// behind" gap this round's own BUILD-SPEC item literally names.
export type DailyBriefSource =
  | "booking"
  | "ordering"
  | "lead"
  | "trade"
  | "email"
  | "invoice"
  | "manual"
  | "aria"
  | "proposal";

/** One candidate brief item, built from a live attention-feed row — not yet checked against existing open items. */
export interface DailyBriefCandidate {
  source: DailyBriefSource;
  title: string;
  link_href: string;
  project_id: string | null;
}

/** The subset of an existing daily_brief_items row the dedupe check needs. */
export interface ExistingBriefItemForDedupe {
  source: string;
  link_href: string | null;
  status: string;
  brief_date: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DEDUPE_WINDOW_DAYS = 7;

function parseDateOnly(s: string): number {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** DD/MM formatting — mirrors lib/order-by.ts's formatOrderByWorksDate() / app/api/my-work/route.ts's formatWorksDate() exactly, so a brief item's "works 21/07" suffix looks identical to the same date rendered anywhere else in this codebase. */
export function formatBriefWorksDate(dateOnly: string): string {
  const [, month, day] = dateOnly.split("-");
  return `${day}/${month}`;
}

/**
 * Whether `candidate` already has a matching OPEN item within the last
 * `DEDUPE_WINDOW_DAYS` days — same (source, link_href) pair, per
 * BUILD-SPEC's "dedupe: don't recreate an open item with same
 * source+link". `now` anchors the 7-day lookback window.
 */
export function hasOpenDuplicate(
  candidate: DailyBriefCandidate,
  existing: ExistingBriefItemForDedupe[],
  now: Date = new Date()
): boolean {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoffMs = todayMs - DEDUPE_WINDOW_DAYS * DAY_MS;
  return existing.some(
    (e) =>
      e.status === "open" &&
      e.source === candidate.source &&
      (e.link_href ?? "") === candidate.link_href &&
      parseDateOnly(e.brief_date) >= cutoffMs
  );
}

/**
 * Filters a candidate list down to the ones that should actually be
 * inserted this run — i.e. every candidate WITHOUT an open duplicate
 * (hasOpenDuplicate above). This is the single function the generator
 * route calls per feed; see this module's own header comment for the
 * full idempotency story.
 */
export function dedupeCandidates(
  candidates: DailyBriefCandidate[],
  existing: ExistingBriefItemForDedupe[],
  now: Date = new Date()
): DailyBriefCandidate[] {
  return candidates.filter((c) => !hasOpenDuplicate(c, existing, now));
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * BUILD-SPEC.md: "carried-over items get a subtle 'from yesterday'
 * tag" (extended here to "from {weekday}" for anything older than
 * yesterday, per this round's own brief: "items still open from
 * previous days remain listed with a 'from yesterday'/'from {weekday}'
 * tag"). Returns null for an item whose brief_date IS today (no tag —
 * it's a fresh item, not carried over). `now` anchors "today".
 */
export function carriedOverLabel(briefDate: string, now: Date = new Date()): string | null {
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const itemMs = parseDateOnly(briefDate);
  const diffDays = Math.round((todayMs - itemMs) / DAY_MS);
  if (diffDays <= 0) return null;
  if (diffDays === 1) return "from yesterday";
  // 2-6 days old: name the weekday it first appeared. 7+ days old: a
  // plain day count reads more usefully than a weekday name that could
  // be ambiguous a week-plus later ("from Tuesday" said on the NEXT
  // Tuesday would misleadingly suggest "today").
  if (diffDays < 7) {
    const d = new Date(itemMs);
    return `from ${WEEKDAY_NAMES[d.getUTCDay()]}`;
  }
  return `from ${diffDays} days ago`;
}

// ------------------------------------------------------------
// Candidate builders — one per source feed. Each takes the minimal
// projection of the underlying feed's own compute-function output (or
// raw rows, for feeds with no existing compute function) and returns
// DailyBriefCandidate[]. The route is responsible for fetching the
// underlying data (reusing the SAME lib functions those feeds' own
// routes already use — lib/board-cockpit.ts's computeBookingsOverdue,
// lib/order-by.ts's deriveOrderBy, lib/leads.ts's
// computeAttentionGroups — never re-deriving the logic here) and
// passing it through these builders for title/link formatting only.
// ------------------------------------------------------------

/** source: 'booking' — BUILD-SPEC "bookings_overdue -> 'Book {task} — works {date}' (source booking, link to board ?focus)". */
export interface BookingCandidateInput {
  task_id: string;
  task_title: string;
  project_id: string;
  date: string;
}

export function buildBookingCandidates(rows: BookingCandidateInput[]): DailyBriefCandidate[] {
  return rows.map((r) => ({
    source: "booking",
    title: `Book ${r.task_title} — works ${formatBriefWorksDate(r.date)}`,
    link_href: `/projects/${r.project_id}/board?focus=board_task-${r.task_id}`,
    project_id: r.project_id,
  }));
}

/** source: 'ordering' — BUILD-SPEC "ordering_due -> 'Order N items for {trade} — works {date}' (source ordering, link to P&P)". One candidate per (project, matched preset) group — same grouping GET /api/my-work's own ordering_due rollup already performs. */
export interface OrderingCandidateInput {
  project_id: string;
  preset_name: string;
  count: number;
  earliest_order_by: string;
  earliest_works_date: string;
  first_item_id: string;
}

export function buildOrderingCandidates(groups: OrderingCandidateInput[]): DailyBriefCandidate[] {
  return groups.map((g) => ({
    source: "ordering",
    title: `Order ${g.count} item${g.count === 1 ? "" : "s"} for ${g.preset_name} — works ${formatBriefWorksDate(g.earliest_works_date)}`,
    link_href: `/projects/${g.project_id}?tab=ffe&focus=ordering_due-${g.first_item_id}`,
    project_id: g.project_id,
  }));
}

/** source: 'lead' — nurture (Proposal Sent, stalled) + stale_proposals (Awaiting to Send Proposal, stalled) groups from lib/leads.ts's computeAttentionGroups(). link_href carries a `lead=` query param purely so two different leads never collide on the dedupe key — the leads page itself does not yet consume it (no per-lead deep-link/focus anchor exists there today; see this function's own inline note). */
export interface LeadCandidateInput {
  id: string;
  surname_project: string;
}

export function buildLeadCandidates(
  nurture: LeadCandidateInput[],
  staleProposals: LeadCandidateInput[]
): DailyBriefCandidate[] {
  const nurtureItems: DailyBriefCandidate[] = nurture.map((l) => ({
    source: "lead",
    title: `Nurture — ${l.surname_project} (Proposal Sent, no movement)`,
    link_href: `/leads?lead=${l.id}`,
    project_id: null,
  }));
  const staleItems: DailyBriefCandidate[] = staleProposals.map((l) => ({
    source: "lead",
    title: `Stale proposal — ${l.surname_project} (still awaiting to send)`,
    link_href: `/leads?lead=${l.id}`,
    project_id: null,
  }));
  return [...nurtureItems, ...staleItems];
}

/** source: 'trade' — trade proposed_change (a trade asked to move a booked visit). Mirrors GET /api/my-work's own trade_proposal source's title/link exactly. */
export interface TradeProposalCandidateInput {
  visit_id: string;
  project_id: string;
  contact_company: string | null;
}

export function buildTradeProposalCandidates(rows: TradeProposalCandidateInput[]): DailyBriefCandidate[] {
  return rows.map((r) => ({
    source: "trade",
    title: r.contact_company ? `${r.contact_company} proposed a new time` : "Trade proposed a new time",
    link_href: `/projects/${r.project_id}/timeline?focus=trade_proposal-${r.visit_id}`,
    project_id: r.project_id,
  }));
}

/** source: 'trade' — expiring/expired insurance. BUILD-SPEC: "expiring insurance -> (source trade or manual? use 'trade')". Same `contact=` query-param-for-uniqueness approach as buildLeadCandidates() above — /contacts has no per-contact deep-link anchor today either. */
export interface InsuranceCandidateInput {
  contact_id: string;
  company: string;
  status: "expiring" | "expired";
}

export function buildInsuranceCandidates(rows: InsuranceCandidateInput[]): DailyBriefCandidate[] {
  return rows.map((r) => ({
    source: "trade",
    title: `${r.company} — insurance ${r.status}`,
    link_href: `/contacts?contact=${r.contact_id}`,
    project_id: null,
  }));
}

// ------------------------------------------------------------
// 7am email — BUILD-SPEC.md "Email: 7am cron ... sends the glance
// email (counts + top items + one button to /my-work) via
// sendTeamEmail to admins; skips when zero items." Pure string
// formatting only (no I/O) — the caller (the generate route) decides
// WHETHER to send (Gmail configured? any open items?) and does the
// actual sendTeamEmail() call; this function only builds the
// subject/body from data already fetched.
// ------------------------------------------------------------

const SOURCE_LABEL: Record<DailyBriefSource, string> = {
  booking: "Bookings",
  ordering: "Ordering",
  lead: "Leads",
  trade: "Trade",
  email: "Email",
  invoice: "Invoices",
  manual: "Manual",
  aria: "Aria",
  // QA fix round (r27) item 14 — see DailyBriefSource's own comment.
  proposal: "Proposals",
};

export interface BriefEmailItem {
  source: DailyBriefSource;
  title: string;
}

/**
 * BUILD-SPEC.md: "subject 'Daily brief — {date} · N items', body =
 * counts by source + top 5 titles + link to {appUrl}/my-work." `date`
 * is expected pre-formatted by the caller (this module stays free of
 * any date-formatting convention choice — the caller already has one,
 * see app/api/brief/generate/route.ts). `openItems` is every currently
 * OPEN brief item (not just ones created by this run — a carried-over
 * item from yesterday is just as much "today's brief" as a
 * freshly-generated one, so the email reflects the same set GET
 * /api/brief itself would show).
 */
export function buildBriefEmailContent(
  openItems: BriefEmailItem[],
  date: string,
  appUrl: string
): { subject: string; body: string } {
  const n = openItems.length;
  const subject = `Daily brief — ${date} · ${n} item${n === 1 ? "" : "s"}`;

  const countsBySource = new Map<DailyBriefSource, number>();
  for (const item of openItems) {
    countsBySource.set(item.source, (countsBySource.get(item.source) ?? 0) + 1);
  }
  const countsLine = [...countsBySource.entries()]
    .map(([source, count]) => `${SOURCE_LABEL[source]}: ${count}`)
    .join(" · ");

  const topFive = openItems.slice(0, 5).map((item) => `- ${item.title}`);

  const lines = [
    `Good morning — ${n} item${n === 1 ? "" : "s"} waiting in today's Daily Brief.`,
    "",
    countsLine,
    "",
    ...topFive,
    n > 5 ? `...and ${n - 5} more.` : null,
    "",
    `Open the brief: ${appUrl.replace(/\/+$/, "")}/my-work`,
  ].filter((l): l is string => l !== null);

  return { subject, body: lines.join("\n") };
}
