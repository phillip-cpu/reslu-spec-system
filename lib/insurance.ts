// ============================================================
// RESLU Spec System — Trade insurance compliance (Fix Round A)
// Pure, dependency-free domain logic — no Supabase/Next imports, plain
// data in/out — mirroring lib/leads.ts and lib/trade-visits.ts's exact
// shape so the "expiring/missing/expired" thresholds can never drift
// between the API layer, the needs-attention feed, and the UI badge.
//
// BUILD-SPEC.md "Trade insurance compliance (Aria-managed)": "migration
// 023: contact_documents (contact_id, kind: public_liability|
// workers_comp|licence|other, storage_path, expiry_date, verified_at) +
// contacts.insurance_status computed (current/expiring <=30d/expired/
// missing) ... 'missing' only for contacts with category in a
// trades-list constant, not suppliers ... block-warning when booking a
// trade with expired insurance on trade_visits."
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_SOON_DAYS = 30;

export type ContactDocumentKind = "public_liability" | "workers_comp" | "licence" | "other";

export interface ContactDocument {
  id: string;
  contact_id: string;
  kind: ContactDocumentKind;
  storage_path: string;
  filename: string;
  expiry_date: string | null;
  verified_at: string | null;
  uploaded_by: string | null;
  created_at: string;
  deleted_at: string | null;
}

/** body accepted by POST /api/contacts/[id]/documents (metadata-only — see route doc comment for the signed-upload-url two-step). */
export interface CreateContactDocumentInput {
  kind: ContactDocumentKind;
  storage_path: string;
  filename: string;
  expiry_date?: string | null;
}

/** body accepted by PATCH /api/contact-documents/[id]. */
export interface PatchContactDocumentInput {
  expiry_date?: string | null;
  verified_at?: string | null;
}

export type InsuranceStatus = "current" | "expiring" | "expired" | "missing";

/**
 * Categories treated as "trades" for the purpose of computing
 * insurance status — BUILD-SPEC.md: "'missing' only for contacts with
 * category in a trades-list constant, not suppliers". contacts.category
 * is free text (migration 013 — "free text w/ suggestions", no enum),
 * so this is necessarily a best-effort, case-insensitive match against
 * the categories this studio actually uses today (seeded from the
 * Monday address-book export categories named in BUILD-SPEC.md's
 * Address Book section: "Appliances, Carpenters, Architect, Tapware &
 * Sanitaryware, etc."). A contact whose category is a supplier/
 * product category (Appliances, Tapware & Sanitaryware, etc.) or has
 * no category at all is NEVER shown "missing" — only "current",
 * "expiring", or "expired" can apply if such a contact happens to have
 * uploaded documents anyway (nothing stops a supplier having a
 * licence on file), but the absence of any document is not flagged as
 * a compliance gap for them, since insurance/licence tracking is a
 * trades concern, not a supplier one.
 *
 * This list is intentionally an allow-list of on-site trade
 * categories, not a deny-list of supplier categories, so a brand-new
 * category typed into the free-text field defaults to "not a trade"
 * (no missing-insurance nag) until a human adds it here — a false
 * negative (a real trade not flagged) is a much smaller annoyance than
 * a false positive (every new supplier category nagging for
 * insurance).
 */
export const TRADE_CATEGORIES = [
  "carpenters",
  "carpentry",
  "electrical",
  "electrician",
  "electricians",
  "plumbing",
  "plumber",
  "plumbers",
  "tiling",
  "tiler",
  "tilers",
  "painting",
  "painter",
  "painters",
  "plastering",
  "plasterer",
  "waterproofing",
  "demolition",
  "carpet & flooring",
  "flooring",
  "cabinetry",
  "cabinet makers",
  "joinery",
  "concreting",
  "bricklaying",
  "roofing",
  "landscaping",
  "glazing",
  "rendering",
  "insulation",
  "hvac",
  "air conditioning",
  "scaffolding",
  "site management",
  "builder",
  "building",
] as const;

/** Case-insensitive, trimmed check against TRADE_CATEGORIES. */
export function isTradeCategory(category: string | null): boolean {
  if (!category) return false;
  return (TRADE_CATEGORIES as readonly string[]).includes(category.trim().toLowerCase());
}

function parseDateOnly(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function todayUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Computes a single contact's insurance_status from their non-deleted
 * contact_documents. Only `public_liability` and `workers_comp`
 * document kinds count towards compliance (a `licence` or `other`
 * document expiring doesn't make a trade "uninsured" — those two
 * kinds are the ones this feature is named for and the ones
 * trade_visits booking warns against). Rule, most-severe-wins across
 * every qualifying document:
 *
 * - expired: at least one qualifying document's expiry_date has
 *   already passed.
 * - expiring: no expired document, but at least one qualifying
 *   document's expiry_date falls within the next 30 days inclusive.
 * - current: at least one qualifying document exists, none expired or
 *   expiring soon (or a qualifying document has no expiry_date at all
 *   — treated as current, not expiring/expired, since an
 *   indefinite/no-expiry document — e.g. a perpetual licence — isn't
 *   a compliance gap).
 * - missing: zero qualifying documents AND isTradeCategory(category)
 *   — per BUILD-SPEC "'missing' only for contacts with category in a
 *   trades-list constant, not suppliers". A non-trade contact with
 *   zero qualifying documents returns "current" (nothing to flag).
 */
export function computeInsuranceStatus(
  category: string | null,
  documents: Pick<ContactDocument, "kind" | "expiry_date" | "deleted_at">[],
  now: Date = new Date()
): InsuranceStatus {
  const qualifying = documents.filter(
    (d) => !d.deleted_at && (d.kind === "public_liability" || d.kind === "workers_comp")
  );

  if (qualifying.length === 0) {
    return isTradeCategory(category) ? "missing" : "current";
  }

  const today = todayUtcMidnight(now);
  let anyExpiring = false;

  for (const doc of qualifying) {
    if (!doc.expiry_date) continue; // no-expiry document never counts against status
    const expiry = parseDateOnly(doc.expiry_date);
    const daysUntilExpiry = Math.round((expiry.getTime() - today.getTime()) / DAY_MS);
    if (daysUntilExpiry < 0) return "expired"; // most severe — short-circuit
    if (daysUntilExpiry <= EXPIRING_SOON_DAYS) anyExpiring = true;
  }

  return anyExpiring ? "expiring" : "current";
}

/** A contacts row's insurance status plus the underlying documents used to derive it — GET /api/contacts response shape (this task's addition) and the needs-attention feed's input. */
export interface ContactWithInsurance {
  id: string;
  company: string;
  category: string | null;
  insurance_status: InsuranceStatus;
}

export interface InsuranceAttentionGroups {
  /** insurance_status === 'expired' among trade-category contacts. */
  expired: ContactWithInsurance[];
  /** insurance_status === 'expiring' among trade-category contacts. */
  expiring: ContactWithInsurance[];
  /** insurance_status === 'missing' — always trade-category by computeInsuranceStatus's own definition. */
  missing: ContactWithInsurance[];
}

/**
 * Groups already-computed contact insurance statuses into the three
 * needs-attention buckets — shared by GET /api/contacts/attention (a
 * standalone panel, mirroring GET /api/leads/attention and GET
 * /api/visits/attention's existing pattern) and GET /api/my-work
 * (folded in additively as MyWorkItemKind 'insurance_expiring' — see
 * app/api/my-work/route.ts's doc comment for exactly how). Only
 * trade-category contacts are ever included (non-trade contacts are
 * always "current" per computeInsuranceStatus, so filtering by status
 * alone already excludes them; the explicit isTradeCategory guard here
 * is defence-in-depth, not load-bearing).
 */
export function computeInsuranceAttention(
  contacts: ContactWithInsurance[]
): InsuranceAttentionGroups {
  const expired: ContactWithInsurance[] = [];
  const expiring: ContactWithInsurance[] = [];
  const missing: ContactWithInsurance[] = [];

  for (const c of contacts) {
    if (!isTradeCategory(c.category) && c.insurance_status !== "current") {
      // Defensive — should never happen given computeInsuranceStatus's
      // own contract, but a non-trade contact is never surfaced here
      // regardless of what status ends up on the row.
      continue;
    }
    if (c.insurance_status === "expired") expired.push(c);
    else if (c.insurance_status === "expiring") expiring.push(c);
    else if (c.insurance_status === "missing") missing.push(c);
  }

  return { expired, expiring, missing };
}

/**
 * The booking-time warning check — BUILD-SPEC.md: "creating/confirming
 * a visit for a contact with expired/missing insurance shows a warning
 * (non-blocking) in the booking UI + API response flag." Returns null
 * (no warning) for 'current'/'expiring' statuses — "expiring" alone
 * isn't a booking blocker-warning, only actually expired or entirely
 * missing cover is worth interrupting the booking flow for.
 */
export function insuranceWarningForBooking(status: InsuranceStatus): string | null {
  if (status === "expired") {
    return "This trade's insurance has expired. You can still book this visit, but consider chasing updated documents first.";
  }
  if (status === "missing") {
    return "No insurance documents are on file for this trade. You can still book this visit, but consider requesting documents first.";
  }
  return null;
}
