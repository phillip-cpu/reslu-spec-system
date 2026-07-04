import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { syncOrderedItem } from "@/lib/monday";
import type { Item } from "@/types";

/**
 * Columns the internal team may edit via the register / P&P view.
 * Whitelist (not blacklist) so identity, audit, client-interaction,
 * scrape and Monday-sync columns can never be written from the client.
 * item_code is intentionally immutable — it is DB-generated at insert.
 */
const EDITABLE_FIELDS = new Set([
  // Spec view
  "name",
  "description",
  "category",
  "supplier",
  "supplier_email",
  "brand",
  "quantity",
  "unit",
  "location",
  "application_note",
  "colour",
  "material",
  "finish",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "status",
  "product_url",
  "selected_image_url",
  // Pricing & Procurement view (accepted here; never surfaced on portal/PDF)
  "price_rrp",
  "price_trade",
  "markup_pct",
  "lead_time_weeks",
  "ordered_at",
  "eta",
  "delivered_at",
]);

const NUMERIC_FIELDS = new Set([
  "quantity",
  "width_mm",
  "height_mm",
  "length_mm",
  "depth_mm",
  "price_rrp",
  "price_trade",
  "markup_pct",
  "lead_time_weeks",
]);

const TEXT_FIELDS = new Set([
  "name",
  "description",
  "category",
  "supplier",
  "supplier_email",
  "brand",
  "unit",
  "location",
  "application_note",
  "colour",
  "material",
  "finish",
  "status",
  "product_url",
  "selected_image_url",
]);

/**
 * GET /api/items/[id]
 * Returns the full item row (all columns — this route is used by the
 * item detail panel, which is internal-team-only, so pricing/procurement
 * fields are fine here; the Spec register LIST endpoint is the one that
 * must stay spec-safe) plus its notes, ordered oldest first.
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

  const { data: item, error } = await supabase
    .from("items")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (error || !item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const { data: notes } = await supabase
    .from("item_notes")
    .select("*")
    .eq("item_id", id)
    .order("created_at", { ascending: true });

  return NextResponse.json({ item, notes: notes ?? [] });
}

/**
 * PATCH /api/items/[id]
 * body: partial item. Only whitelisted fields are applied; unknown
 * or protected keys are silently dropped. Empty strings become null
 * (so the register / PDF can suppress empty fields) — except `name`,
 * which must stay non-empty.
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;

    if (NUMERIC_FIELDS.has(key)) {
      if (raw === "" || raw === null || raw === undefined) {
        update[key] = null;
      } else {
        const n = Number(raw);
        if (Number.isNaN(n)) {
          return NextResponse.json(
            { error: `${key} must be a number` },
            { status: 400 }
          );
        }
        update[key] = n;
      }
    } else if (TEXT_FIELDS.has(key)) {
      const trimmed = typeof raw === "string" ? raw.trim() : raw;
      update[key] = trimmed === "" ? null : trimmed;
    } else {
      // date fields (ordered_at, eta, delivered_at): pass through, "" → null
      update[key] = raw === "" ? null : raw;
    }
  }

  if ("name" in update && (update.name === null || update.name === undefined)) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No editable fields in request" },
      { status: 400 }
    );
  }

  const { data: item, error } = await supabase
    .from("items")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // One-way Monday sync when an item transitions to Ordered. Best-effort:
  // a Monday failure (or a missing token) never fails the edit. Dormant
  // until MONDAY_API_TOKEN + the project's monday_board_id are set.
  let synced: Item = item as Item;
  if (update.status === "Ordered" && !synced.monday_item_id) {
    try {
      const { data: project } = await supabase
        .from("projects")
        .select("name,monday_board_id")
        .eq("id", synced.project_id)
        .single();
      if (project) {
        const result = await syncOrderedItem(synced, project);
        if (!result.skipped && result.mondayItemId) {
          const { data: reSynced } = await supabase
            .from("items")
            .update({
              monday_item_id: result.mondayItemId,
              monday_synced_at: new Date().toISOString(),
            })
            .eq("id", synced.id)
            .select()
            .single();
          if (reSynced) synced = reSynced as Item;
        }
      }
    } catch {
      // swallow — sync is non-critical to the edit
    }
  }

  return NextResponse.json({ item: synced });
}

/**
 * DELETE /api/items/[id]
 * Soft-deletes (sets deleted_at) — parity with project archiving and
 * the audit-trail intent (BUILD-SPEC.md §9 / Review §1.9). The row is
 * retained; the partial unique index on (project_id, item_code) only
 * covers active rows, so the code frees up for reuse.
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
    .from("items")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id)
    .is("deleted_at", null);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
