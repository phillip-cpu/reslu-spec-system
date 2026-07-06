// ============================================================
// RESLU Spec System — Trade insurance compliance
// Pure, dependency-free domain logic — no Supabase/Next imports, plain
// data in/out — mirroring lib/leads.ts and lib/trade-visits.ts's exact
// shape so the "expiring/missing/expired" thresholds can never drift
// between the API layer, the needs-attention feed, and the UI badge.
//
// Quick items round (Phillip, 6 July 2026), item 1 — "Insurance
// required flag": REPLACES the former category-heuristic guess (the
// TRADE_CATEGORIES allow-list + isTradeCategory() this file used to
// export — Fix Round A) with a single explicit column,
// contacts.insurance_required (migration 026), ticked per contact from
// components/contacts/ContactsBrowser.tsx's expand panel. Single
// source of truth going forward: a contact is only ever "missing" when
// insurance_required = true AND it has no current qualifying document
// on file. Migration 026's one-time backfill seeded this column from
// exactly the category list this file used to hardcode (see that
// migration's own comment for the literal copy) — that list is not
// reproduced here any more; the column is the only thing read now.
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

function parseDateOnly(s: string): Date {
  return new Date(s + "T00:00:00Z");
}

function todayUtcMidnight(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Computes a single contact's insurance_status from their
 * `insurance_required` flag (contacts.insurance_required, migration
 * 026) and their non-deleted contact_documents. Only `public_liability`
 * and `workers_comp` document kinds count towards compliance (a
 * `licence` or `other` document expiring doesn't make a trade
 * "uninsured" — those two kinds are the ones this feature is named for
 * and the ones trade_visits booking warns against). Rule,
 * most-severe-wins across every qualifying document:
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
 * - missing: zero qualifying documents AND insuranceRequired is true —
 *   per this round's brief: "insurance_required = true + no current
 *   docs = 'missing'; false = null/no badge". A contact with
 *   insurance_required = false and zero qualifying documents returns
 *   "current" (nothing to flag, no badge rendered).
 */
export function computeInsuranceStatus(
  insuranceRequired: boolean,
  documents: Pick<ContactDocument, "kind" | "expiry_date" | "deleted_at">[],
  now: Date = new Date()
): InsuranceStatus {
  const qualifying = documents.filter(
    (d) => !d.deleted_at && (d.kind === "public_liability" || d.kind === "workers_comp")
  );

  if (qualifying.length === 0) {
    return insuranceRequired ? "missing" : "current";
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

/** A contacts row's insurance status plus the underlying documents used to derive it — GET /api/contacts response shape and the needs-attention feed's input. */
export interface ContactWithInsurance {
  id: string;
  company: string;
  insurance_required: boolean;
  insurance_status: InsuranceStatus;
}

export interface InsuranceAttentionGroups {
  /** insurance_status === 'expired' among insurance_required contacts. */
  expired: ContactWithInsurance[];
  /** insurance_status === 'expiring' among insurance_required contacts. */
  expiring: ContactWithInsurance[];
  /** insurance_status === 'missing' — always insurance_required by computeInsuranceStatus's own definition. */
  missing: ContactWithInsurance[];
}

/**
 * Groups already-computed contact insurance statuses into the three
 * needs-attention buckets — shared by GET /api/contacts/attention (a
 * standalone panel, mirroring GET /api/leads/attention and GET
 * /api/visits/attention's existing pattern) and GET /api/my-work
 * (folded in additively as MyWorkItemKind 'insurance_expiring' — see
 * app/api/my-work/route.ts's doc comment for exactly how). Only
 * insurance_required contacts are ever included (a contact with
 * insurance_required = false is always "current" per
 * computeInsuranceStatus, so filtering by status alone already excludes
 * it; the explicit guard here is defence-in-depth, not load-bearing).
 */
export function computeInsuranceAttention(
  contacts: ContactWithInsurance[]
): InsuranceAttentionGroups {
  const expired: ContactWithInsurance[] = [];
  const expiring: ContactWithInsurance[] = [];
  const missing: ContactWithInsurance[] = [];

  for (const c of contacts) {
    if (!c.insurance_required && c.insurance_status !== "current") {
      // Defensive — should never happen given computeInsuranceStatus's
      // own contract, but a contact with insurance_required = false is
      // never surfaced here regardless of what status ends up on the
      // row.
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
