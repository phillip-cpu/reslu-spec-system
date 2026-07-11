import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// RESLU Spec System — Grouped trade booking round (r20). Small shared
// server helper used by the /api/trade-request/[token]/documents/*
// proxy routes (plans/schedule/sow) — resolving "which underlying
// trade_visits row's confirm_token should this grouped-request
// document link redirect to."
// ============================================================

/**
 * A grouped request's document_pack is frozen IDENTICALLY onto every
 * line at send time (POST /api/projects/[id]/trade-requests) — so
 * rather than duplicating the plans/schedule/SOW rendering logic that
 * already lives behind the r15 per-visit confirm_token
 * (app/api/trade/[token]/documents/**), the three grouped-request
 * document routes simply find ONE representative, non-deleted line for
 * this request and 307-redirect to that line's OWN confirm_token
 * proxy — genuine reuse of the existing pack machinery (BUILD-SPEC.md
 * item 2: "reuse existing pack machinery"), not a parallel
 * implementation. Picks the line with the LATEST end_date (the one
 * least likely to have already expired, per lib/trade-visits.ts's
 * isVisitExpired — "today > end_date") so a grouped request with a mix
 * of near-term and far-out lines doesn't route documents through an
 * already-expired line while a live one still exists.
 */
export async function findRepresentativeVisitToken(
  supabase: SupabaseClient,
  bookingRequestId: string
): Promise<string | null> {
  const { data: visits } = await supabase
    .from("trade_visits")
    .select("confirm_token,end_date")
    .eq("booking_request_id", bookingRequestId)
    .is("deleted_at", null)
    .order("end_date", { ascending: false })
    .limit(1);
  return visits?.[0]?.confirm_token ?? null;
}

/**
 * A grouped request has no single "expiry" concept the way one r15
 * visit does (isVisitExpired, keyed off ONE end_date) — a request with
 * five lines spread across two months is still "live" as long as ANY
 * line hasn't passed its end_date yet. True only when EVERY non-
 * deleted line linked to this request has already passed (today >
 * end_date) — shared by the public page and the respond route so both
 * agree on when a token stops accepting responses, same "re-derive
 * independently of the page component" discipline as the r15 flow's
 * isVisitExpired.
 */
export function isRequestFullyExpired(
  lines: { end_date: string; deleted_at?: string | null }[],
  now: Date = new Date()
): boolean {
  const live = lines.filter((l) => !l.deleted_at);
  if (live.length === 0) return true;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return live.every((l) => today.getTime() > new Date(l.end_date + "T00:00:00Z").getTime());
}
