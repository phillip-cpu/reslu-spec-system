import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceStatus } from "@/lib/insurance";
import type { CreateContactInput } from "@/types";

/**
 * GET /api/contacts?limit=&offset=
 * Team-visible, not admin-gated (BUILD-SPEC.md "Address Book": "Team-
 * visible" — no financial data here). Query: ?q= (search across
 * company/contact_name/specialty), ?category= (exact match). Ordered
 * company asc, non-deleted only. Mirrors GET /api/library's search +
 * category-filter shape (see app/api/library/route.ts).
 *
 * Phase 14A pagination: previously unbounded (`select("*")` with no
 * limit at all). HONEST CAVEAT: this is NOT byte-for-byte identical
 * for every possible dataset size — an address book that ever exceeds
 * DEFAULT_LIMIT (500) rows would now see this route silently return
 * only the first 500 rather than every row, for any existing caller
 * that doesn't pass ?limit (ContactsBrowser.tsx, SupplierContactPicker.tsx,
 * ContactLinkPicker.tsx, GanttChart.tsx, ProjectBoard.tsx). This
 * studio's real contacts count today is nowhere near 500 — but if that
 * ever changes, those callers need to actually adopt ?limit/?offset
 * (or DEFAULT_LIMIT needs raising) before it silently truncates.
 * `total` (exact count) is returned precisely so a consumer CAN notice
 * "total > contacts.length" and know more exists.
 *
 * FIX ROUND A — Trade insurance tracker: every returned contact now
 * also carries `insurance_status` (computed via lib/insurance.ts's
 * computeInsuranceStatus() from that contact's `insurance_required`
 * flag — migration 026, Quick items round 6 July 2026 — and its
 * non-deleted contact_documents — migration 023) and `document_count`
 * (how many non-deleted documents are on file, for the badge/expand
 * affordance — see components/contacts/ContactsBrowser.tsx). Batched
 * (one extra query for every contact_document row across the whole
 * page of contacts, not one query per contact) — same "not N+1"
 * discipline as every other per-row annotation in this codebase
 * (contact summaries on phases/visits/board tasks, etc.).
 */
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim();
  const category = searchParams.get("category")?.trim();

  const limitParam = Number(searchParams.get("limit"));
  const offsetParam = Number(searchParams.get("offset"));
  const limit =
    Number.isFinite(limitParam) && limitParam > 0
      ? Math.min(Math.floor(limitParam), MAX_LIMIT)
      : DEFAULT_LIMIT;
  const offset =
    Number.isFinite(offsetParam) && offsetParam > 0 ? Math.floor(offsetParam) : 0;

  let query = supabase
    .from("contacts")
    .select("*", { count: "exact" })
    .is("deleted_at", null)
    .order("company", { ascending: true })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.eq("category", category);
  }
  if (q) {
    const escaped = q.replace(/[%_]/g, (m) => `\\${m}`);
    query = query.or(
      `company.ilike.%${escaped}%,contact_name.ilike.%${escaped}%,specialty.ilike.%${escaped}%`
    );
  }

  const { data, error, count } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const contacts = data ?? [];
  const contactIds = contacts.map((c) => c.id);

  type DocRow = {
    contact_id: string;
    kind:
      | "public_liability"
      | "professional_indemnity"
      | "workers_comp"
      | "licence"
      | "other";
    expiry_date: string | null;
    deleted_at: string | null;
  };
  const { data: documents } = contactIds.length
    ? await supabase
        .from("contact_documents")
        .select("contact_id,kind,expiry_date,deleted_at")
        .in("contact_id", contactIds)
        .is("deleted_at", null)
    : { data: [] as DocRow[] };

  const docsByContact = new Map<string, DocRow[]>();
  for (const d of (documents ?? []) as DocRow[]) {
    const list = docsByContact.get(d.contact_id) ?? [];
    list.push(d);
    docsByContact.set(d.contact_id, list);
  }

  const contactsWithInsurance = contacts.map((c) => {
    const docs = docsByContact.get(c.id) ?? [];
    return {
      ...c,
      insurance_status: computeInsuranceStatus(c.insurance_required, docs),
      document_count: docs.length,
    };
  });

  return NextResponse.json({ contacts: contactsWithInsurance, total: count ?? contacts.length, limit, offset });
}

/**
 * POST /api/contacts
 * Team-visible — any signed-in team member may add a contact (same
 * trust tier as library_items, which any team member may also create).
 * Body: CreateContactInput — only `company` is required.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateContactInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.company?.trim()) {
    return NextResponse.json({ error: "company is required" }, { status: 400 });
  }

  const insert = {
    company: body.company.trim(),
    contact_name: body.contact_name?.trim() || null,
    phone: body.phone?.trim() || null,
    email: body.email?.trim() || null,
    website: body.website?.trim() || null,
    specialty: body.specialty?.trim() || null,
    category: body.category?.trim() || null,
    notes: body.notes?.trim() || null,
    created_by: user.id,
  };

  const { data: contact, error } = await supabase
    .from("contacts")
    .insert(insert)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ contact }, { status: 201 });
}
