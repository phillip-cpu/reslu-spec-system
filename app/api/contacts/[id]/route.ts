import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeInsuranceStatus } from "@/lib/insurance";
import type { PatchContactInput } from "@/types";

const EDITABLE_FIELDS = new Set([
  "company",
  "contact_name",
  "phone",
  "email",
  "website",
  "specialty",
  "category",
  "notes",
]);

/**
 * GET /api/contacts/[id]
 * Team-visible. Response: { contact }.
 *
 * FIX ROUND A: the single-contact read also carries `insurance_status`
 * (computed the same way GET /api/contacts's list route does — see
 * that route's doc comment) so ContactDocumentsPanel.tsx can re-fetch
 * just this one contact after an upload/delete/expiry-date edit and
 * refresh its parent ContactsBrowser badge without re-fetching the
 * whole list.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: contact, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  const { data: documents } = await supabase
    .from("contact_documents")
    .select("kind,expiry_date,deleted_at")
    .eq("contact_id", id)
    .is("deleted_at", null);

  return NextResponse.json({
    contact: {
      ...contact,
      insurance_status: computeInsuranceStatus(contact.category, documents ?? []),
    },
  });
}

/**
 * PATCH /api/contacts/[id]
 * body: PatchContactInput (partial). Whitelist-only. Empty strings
 * become null (same convention as PATCH /api/items/[id]) except
 * `company`, which must stay non-empty.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: PatchContactInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    const trimmed = typeof raw === "string" ? raw.trim() : raw;
    update[key] = trimmed === "" ? null : trimmed;
  }

  if ("company" in update && !update.company) {
    return NextResponse.json({ error: "company cannot be empty" }, { status: 400 });
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: contact, error } = await supabase
    .from("contacts")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!contact) {
    return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  }

  return NextResponse.json({ contact });
}

/**
 * DELETE /api/contacts/[id]
 * Soft-delete (deleted_at) — per the build brief ("deleted_at" listed
 * explicitly on the contacts table), consistent with items/projects/
 * cost_lines soft-delete rather than library_items' hard-delete
 * (a contact may still be referenced by board cards / cost lines /
 * items / phases via on-delete-set-null FKs, so a soft delete keeps
 * those historical links resolvable via a direct id lookup if ever
 * needed, while the contacts list itself hides it immediately).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { error } = await supabase
    .from("contacts")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
