// ============================================================
// RESLU Spec System — "Trade booking document pack" round LOCAL types
// (8 July 2026). Migration 032_visit_document_pack.sql's
// trade_visits.document_pack, BookVisitPanel's "Include documents"
// section, the trade page's DOCUMENTS section, and the new tokened
// proxy endpoints that serve the picked documents.
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) — follows the exact same per-round-
// own-file convention every phase-N.ts / round-*.ts / board-v3*.ts
// file in this directory already uses (see types/phase-fix-a.ts's
// header comment for the fullest statement of the rationale).
// Everything below is scoped to this round's own files:
// supabase/migrations/032_visit_document_pack.sql,
// app/api/board-tasks/[id]/book-visit/route.ts (document_pack on the
// request body only — the rest of that route is Board v3.3's, not
// re-typed here), app/trade/[token]/page.tsx,
// app/api/trade/[token]/documents/**, components/board/
// BookVisitPanel.tsx, components/trade/TradeDocuments.tsx,
// lib/trade-doc-pack.ts.
//
// Cross-imports from types/index.ts are READ-ONLY reuse of existing,
// already-defined shapes — nothing in that file is modified.
// ============================================================

/**
 * Frozen document-pack choices, made once in BookVisitPanel at booking
 * time and stored verbatim on trade_visits.document_pack (migration
 * 032). See lib/trade-doc-pack.ts's header comment for the full
 * "frozen choices, live revisions" resolution semantics — this type is
 * the choices half only; WHICH actual file satisfies each choice is
 * always resolved fresh at render/request time, never stored here.
 */
export interface DocumentPackChoices {
  /** Whether the trade's booking page offers the project's Plans. */
  include_plans: boolean;
  /**
   * Which schedule categories to include, e.g. ["TW", "SW"] for a
   * preset-matched Plumber.
   *
   * THREE-STATE ENCODING (the one deliberate wrinkle in an otherwise
   * plain shape — read this before touching any code that sets or
   * reads this field):
   *   - KEY ABSENT (`"schedule_categories" in pack` is false) — the
   *     Schedule checkbox was UNTICKED; nothing schedule-related is
   *     offered on the booking page at all.
   *   - `null` — Schedule is ON, no category filter ("full schedule").
   *   - `string[]` (non-empty) — Schedule is ON, filtered to these
   *     upper-cased category prefixes (an auto-picked preset's
   *     prefixes, or a hand-edited custom selection). An empty array
   *     is never stored (BookVisitPanel always resolves either a
   *     concrete preset's prefixes or null).
   * The literal top-level shape BUILD-SPEC.md's own item 1 wording
   * gives is `{include_plans, schedule_categories, include_sow}` — no
   * fourth `include_schedule` boolean. Key PRESENCE therefore carries
   * meaning here, unlike include_plans/include_sow, which are always
   * present, always a plain boolean. Every writer (BookVisitPanel) and
   * every reader (the trade page, all three proxy routes, the email
   * mention-line helpers) must check PRESENCE first, then null-vs-
   * array — never assume the key exists.
   */
  schedule_categories?: string[] | null;
  /** Whether the trade's booking page offers the latest issued Scope of Works. */
  include_sow: boolean;
}

// ------------------------------------------------------------
// Trade page DOCUMENTS section + tokened proxy endpoints.
//
// NOTE: POST /api/board-tasks/[id]/book-visit's request body extends
// BookVisitInput (types/board-cockpit.ts) with `document_pack?:
// DocumentPackChoices` directly inline at that route/BookVisitPanel's
// onBook payload (both use `DocumentPackChoices` straight from this
// file) rather than through a separate named intersection type here —
// there was no second call site that needed the combined shape as its
// own type, so one wasn't added speculatively.
// ------------------------------------------------------------

/** One row the trade page's DOCUMENTS section renders — resolved fresh per page load from document_pack's frozen CHOICES against the project's current LIVE documents (see lib/trade-doc-pack.ts's resolution helpers). */
export interface TradeDocumentRow {
  kind: "plans" | "schedule" | "sow";
  /** Display label, e.g. "Plans (T2)", "Your schedule — Plumber", "Scope of Works (T1)". */
  label: string;
  /** Proxy URL under the /trade/[token] route prefix — see app/api/trade/[token]/documents/**'s own doc comments. This ROW is only ever pushed when a live document currently satisfies the choice — a choice with nothing to resolve (e.g. Plans ticked at booking time but every revision has since been deleted) omits the whole row from the array rather than pushing one with a broken href. */
  href: string;
  /** Human-readable file size, e.g. "2.4 MB" — omitted when the size wasn't cheap to determine (the schedule/SOW are generated PDFs with no stored byte size to read without rendering them; only a real Storage object's plans row gets this). */
  sizeLabel?: string;
}

/** GET /api/trade/[token]/documents/plans, /schedule, /sow — all three proxy routes share this same "stream the PDF, or explain why not" contract; a 200 body is the raw PDF bytes (Content-Type: application/pdf), anything else is JSON `{ error }`. Documented here as a type-level contract note since the routes themselves return a raw NextResponse, not this shape. */
export type TradeDocumentProxyErrorReason =
  | "not_found"
  | "expired"
  | "rate_limited"
  | "not_in_pack"
  | "no_document";
