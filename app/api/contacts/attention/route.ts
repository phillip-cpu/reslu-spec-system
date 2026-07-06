import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceAttention, computeInsuranceStatus } from "@/lib/insurance";
import type { ContactWithInsurance } from "@/lib/insurance";
import type { ContactsAttentionResponse } from "@/types/phase-fix-a";

export const runtime = "nodejs";

/**
 * GET /api/contacts/attention
 * Team-visible, not admin-gated (BUILD-SPEC.md "Trade insurance
 * compliance" carries no financial data — same reasoning as GET
 * /api/leads/attention / GET /api/visits/attention, its two siblings).
 * Response: ContactsAttentionResponse (= lib/insurance.ts's
 * InsuranceAttentionGroups) — { expired, expiring, missing }, each a
 * lean { id, company, category, insurance_status } row (not a full
 * Contact — this feed only ever renders company name + status).
 * Only trade-category contacts (isTradeCategory()) ever appear —
 * suppliers never surface here even if they happen to have an
 * expiring document on file, per BUILD-SPEC.md "'missing' only for
 * contacts with category in a trades-list constant, not suppliers"
 * (extended here to the whole attention feed, not just the 'missing'
 * bucket, since a supplier's insurance status was never something this
 * feature asks anyone to track).
 *
 * This is the STANDALONE panel surface (e.g. for a future dedicated
 * Address Book attention card) — GET /api/my-work's source #7 also
 * surfaces expiring/expired contacts (folded additively into the
 * existing per-user aggregator, per this task's brief: "find and
 * extend additively"). The two are complementary, not redundant: My
 * Work answers "what do I need to act on today"; this route answers
 * "what's the studio's overall insurance-compliance picture" (and is
 * the one Aria's future list_expiring_insurances MCP tool would call —
 * see docs/API.md's "MCP additions" note for that follow-up).
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id,company,category")
    .is("deleted_at", null);
  const contactRows = contacts ?? [];
  const contactIds = contactRows.map((c) => c.id);

  type DocRow = { contact_id: string; kind: "public_liability" | "workers_comp"; expiry_date: string | null; deleted_at: string | null };
  const { data: documents } = contactIds.length
    ? await supabase
        .from("contact_documents")
        .select("contact_id,kind,expiry_date,deleted_at")
        .in("contact_id", contactIds)
        .is("deleted_at", null)
        .in("kind", ["public_liability", "workers_comp"])
    : { data: [] as DocRow[] };

  const docsByContact = new Map<string, DocRow[]>();
  for (const d of (documents ?? []) as DocRow[]) {
    const list = docsByContact.get(d.contact_id) ?? [];
    list.push(d);
    docsByContact.set(d.contact_id, list);
  }

  const withInsurance: ContactWithInsurance[] = contactRows.map((c) => ({
    id: c.id,
    company: c.company,
    category: c.category,
    insurance_status: computeInsuranceStatus(c.category, docsByContact.get(c.id) ?? []),
  }));

  const body: ContactsAttentionResponse = computeInsuranceAttention(withInsurance);
  return NextResponse.json(body);
}
