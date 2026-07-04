import { NextRequest, NextResponse, after } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import { syncItemToMonday } from "@/lib/monday/sync";
import { normalizeProductUrl } from "@/lib/scraper";
import type { Item } from "@/types";

/**
 * Columns the internal team may edit via the register / P&P view.
 * Whitelist (not blacklist) so identity, audit, client-interaction,
 * and Monday-sync columns can never be written from the client.
 * item_code is intentionally immutable — it is DB-generated at insert.
 *
 * Week 4 whitelist fix: this previously omitted several fields the
 * scrape flow and duplicate-detection need to write from the item
 * detail panel (image picking after a scrape, re-normalising the URL
 * on edit, surfacing/clearing scrape state) — verified against
 * migration 004_library_scraper.sql and the Item type:
 *   - image_options          (scrape results: candidate image URLs to
 *                             choose from — jsonb array on items)
 *   - scrape_status          ('pending'|'success'|'partial'|'failed'|
 *                             'vision'|'skipped' — editable so the
 *                             panel can reset/retry state)
 *   - scraped_documents      (detected-but-not-yet-attached PDFs;
 *                             migration 004, cleared as docs get
 *                             attached to item_files)
 *   - product_url_normalized (migration 004 duplicate detection column)
 * selected_image_url was already whitelisted; product_url_normalized
 * is now kept in sync server-side whenever product_url changes (see
 * PATCH below) rather than trusting a client-supplied value for it.
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
  "image_options",
  "scrape_status",
  "scraped_documents",
  // Pricing & Procurement view (accepted here; never surfaced on portal/PDF)
  "price_rrp",
  "price_trade",
  "markup_pct",
  "lead_time_weeks",
  "ordered_at",
  "eta",
  "delivered_at",
]);

/**
 * Financial fields — admin-gated per BUILD-SPEC.md "Financial
 * visibility — role-gated": "API responses strip financial fields for
 * non-admin sessions (not merely hidden in UI)." Same pattern as
 * app/api/library/route.ts's stripFinancials/FINANCIAL_FIELDS. Applies
 * to both the read (GET) and the write (PATCH, below) side: a
 * non-admin PATCH body can supply these keys but they are silently
 * dropped, exactly like an unknown key would be, rather than erroring.
 *
 * price_rrp is deliberately NOT included — it's a public reference
 * price, not the negotiated trade cost (same distinction the library
 * API draws).
 */
const FINANCIAL_FIELDS = new Set(["price_trade", "markup_pct"]);

function stripFinancials<T extends Record<string, unknown>>(item: T): T {
  const clone = { ...item };
  for (const f of FINANCIAL_FIELDS) delete clone[f];
  return clone;
}

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
  "scrape_status",
]);

/** JSON/array fields — pass through as-is (already validated shape by callers). */
const JSON_FIELDS = new Set(["image_options", "scraped_documents"]);

/**
 * GET /api/items/[id]
 * Returns the item row (this route backs the item detail panel, which
 * shows pricing/procurement fields to admins) plus its notes, ordered
 * oldest first. Financial fields (price_trade, markup_pct) are
 * stripped for non-admin sessions per BUILD-SPEC.md "Financial
 * visibility — role-gated" — this GET previously returned `select("*")`
 * with no stripping at all, which was the read-side half of the same
 * gap the PATCH whitelist fix addresses on the write side.
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

  const admin = await isAdmin(supabase);
  const payload = admin ? item : stripFinancials(item);

  return NextResponse.json({ item: payload, notes: notes ?? [] });
}

/**
 * PATCH /api/items/[id]
 * body: partial item. Only whitelisted fields are applied; unknown
 * or protected keys are silently dropped. Empty strings become null
 * (so the register / PDF can suppress empty fields) — except `name`,
 * which must stay non-empty. Financial fields (price_trade,
 * markup_pct) in the body are dropped entirely for non-admin sessions,
 * consistent with app/api/library/route.ts's admin-gating pattern —
 * a non-admin PATCH simply can't move those fields, regardless of
 * what's in the request body.
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
  const admin = await isAdmin(supabase);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (!EDITABLE_FIELDS.has(key)) continue;
    if (!admin && FINANCIAL_FIELDS.has(key)) continue;

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
    } else if (JSON_FIELDS.has(key)) {
      // image_options / scraped_documents: arrays written by the scrape
      // flow and the item panel's image picker. Passed through as-is;
      // undefined/null clears to an empty array rather than nulling the
      // column (both are declared `not null default '[]'`).
      update[key] = raw ?? [];
    } else {
      // date fields (ordered_at, eta, delivered_at): pass through, "" → null
      update[key] = raw === "" ? null : raw;
    }
  }

  if ("name" in update && (update.name === null || update.name === undefined)) {
    return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
  }

  // Keep product_url_normalized in sync server-side whenever product_url
  // changes (BUILD-SPEC.md "Library — trade price capture & duplicate
  // detection") — derived from the whitelisted product_url, never taken
  // directly from the client, so it can't drift out of sync with a
  // stale/forged value.
  if ("product_url" in update) {
    update.product_url_normalized = normalizeProductUrl(update.product_url as string | null);
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

  // One-way Monday sync when an item transitions to Ordered. Fire-and-
  // forget via next/server's after() (same pattern as the fetch-first
  // scrape kickoff in app/api/projects/[id]/items/route.ts's POST) so
  // the response returns immediately — the sync never blocks or fails
  // the item update. Uses its own service-role client rather than the
  // request-scoped cookie-bound one, same reasoning as
  // lib/scraper/index.ts's scrapeProductUrl: work queued via after()
  // can outlive the request/response cycle, and cookie-bound clients
  // are not guaranteed safe to use at that point. Errors are logged
  // server-side only; nothing is written back to the item on failure
  // (no monday_item_id / synced_at stamped) so a later retry
  // (POST /api/monday/sync/[itemId], or the next status change) can
  // pick it up cleanly.
  const typedItem = item as Item;
  if (update.status === "Ordered" && !typedItem.monday_item_id) {
    after(async () => {
      try {
        const service = createServiceRoleClient();
        const { data: project } = await service
          .from("projects")
          .select("name,monday_board_id,settings")
          .eq("id", typedItem.project_id)
          .single();
        if (!project) return;

        const result = await syncItemToMonday(typedItem, project);
        if (!result.skipped && result.mondayItemId) {
          await service
            .from("items")
            .update({
              monday_item_id: result.mondayItemId,
              monday_synced_at: new Date().toISOString(),
            })
            .eq("id", typedItem.id);
        }
      } catch (err) {
        // Errors: log + write nothing — sync is non-critical to the edit.
        console.error(`[monday sync] item ${typedItem.id} failed:`, err);
      }
    });
  }

  const payload = admin
    ? typedItem
    : stripFinancials(typedItem as unknown as Record<string, unknown>);
  return NextResponse.json({ item: payload });
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
