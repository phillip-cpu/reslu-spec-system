import type { SupabaseClient } from "@supabase/supabase-js";

// ============================================================
// RESLU Spec System — QA fix round (r27) item 10: "Daily Brief
// self-close ... resolving a trade suggestion (resolve route),
// approving/rejecting a supplier invoice, and proposal-accept related
// items mark their corresponding daily_brief_items row done (match by
// source/link dedupe key)."
//
// Kept OUT of lib/daily-brief.ts on purpose — that module is explicitly
// "pure, dependency-free ... no Supabase/Next imports" (see its own
// header comment), and this is a real DB write. This is the
// server-only sibling: a tiny shared helper so the three-ish call
// sites this round touches (trade-request resolve, supplier-invoice
// approve/reject, proposal accept) don't each hand-roll the same
// match-by-(source,link_href)-then-update, and can never drift from
// each other on what "closing" actually writes.
//
// Completion semantics per migration 041's own daily_brief_items
// column comments: status='done' + acknowledged_at=now() — the exact
// same pair PATCH /api/brief/items/[id] (the manual tick action)
// writes. Matches ANY still-OPEN row for the given (source, link_href)
// — there should only ever be one (the generator/insert call sites'
// own dedupe guards see to that), but this updates every match rather
// than assuming exactly one, in case an older duplicate ever slipped
// through before a guard existed.
// ============================================================

/**
 * Marks every still-open daily_brief_items row matching (source,
 * link_href) — and, when given, an EXACT title too — as done.
 * Best-effort/never throws — closing a brief item is a courtesy side
 * effect of the caller's real action (accepting a shift, approving an
 * invoice, a client signing a proposal), never something that should
 * turn an otherwise-successful request into a 500. Returns the number
 * of rows closed (0 is normal — most actions won't have a matching
 * open brief item, e.g. a resolve that happens before the Daily Brief
 * cron ever surfaced it).
 *
 * `title` matters for any source whose link_href is shared across
 * several distinct open items — e.g. the Aria supplier-invoice flag
 * (source='invoice') links every flagged invoice on a project to the
 * SAME `/projects/{id}/invoices` href, with the invoice's supplier +
 * number only distinguishing them in the title (see POST
 * /api/projects/[id]/invoices' own daily_brief_items insert) — without
 * it, approving ONE flagged invoice would incorrectly close every
 * OTHER still-pending flagged invoice's item in the same project. A
 * source whose link_href is already unique per item (e.g. the trade
 * suggestion attention row, keyed by `?focus=line-{visitId}`) can omit
 * it.
 */
export async function closeBriefItem(
  supabase: SupabaseClient,
  source: string,
  linkHref: string,
  title?: string
): Promise<number> {
  try {
    let query = supabase
      .from("daily_brief_items")
      .update({ status: "done", acknowledged_at: new Date().toISOString() })
      .eq("source", source)
      .eq("link_href", linkHref)
      .eq("status", "open");
    if (title) query = query.eq("title", title);
    const { data, error } = await query.select("id");
    if (error) {
      console.error("closeBriefItem: update failed", source, linkHref, error.message);
      return 0;
    }
    return data?.length ?? 0;
  } catch (err) {
    console.error("closeBriefItem: unexpected error", source, linkHref, err);
    return 0;
  }
}
