import { NextRequest, NextResponse, after } from "next/server";
import { ensureStoredImage } from "@/lib/images";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import { syncItemToMonday } from "@/lib/monday/sync";
import { reportError } from "@/lib/report-error";
import { normalizeProductUrl } from "@/lib/scraper";
import { ITEM_CODE_PATTERN } from "@/types/phase-small-round";
import type { Item } from "@/types";

/**
 * Columns the internal team may edit via the register / P&P view.
 * Whitelist (not blacklist) so identity, audit, client-interaction,
 * and Monday-sync columns can never be written from the client.
 *
 * "Small round" (6 July 2026) — Improvements backlog item 1: item_code
 * is NO LONGER immutable. It is still DB-*generated* at insert (the
 * trg_items_assign_code trigger, migration 001, is untouched — a
 * blank/omitted code on create still gets auto-numbered exactly as
 * before), but a team member may now correct a generated code after
 * the fact (e.g. the scraper picked the wrong category before a manual
 * recategorisation, or a code was mistyped on CSV import). See the
 * dedicated validation block in PATCH below for the format rule,
 * uniqueness handling, and — importantly — why changing a code does
 * NOT renumber any sibling codes.
 *
 * NOTE: there is no UI for this yet. SpecRegister.tsx (the component
 * that owns the register's editable cells) is outside this round's
 * edit boundary — see docs/HANDOFF-code-editing.md for exact wiring
 * instructions for whoever adds the input there next.
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
 *
 * Week 9 addition: supplier_contact_id (migration 013_boards_contacts.sql)
 * — the Address Book link point for this item's supplier. Team-visible,
 * not financial, so no admin-gating needed for this field.
 *
 * Phase 11 extension: decision_needed_by (migration 016_portal_v2.sql)
 * — design-phase decision deadline. The column and its portal-side
 * read/render shipped in Phase 11B, but that agent didn't own this
 * file, so there was previously no write path for staff to actually
 * set one (see docs/API.md's "Known gap" note on this route, now
 * closed). Plain team-editable date, not financial — no admin-gating.
 * Falls through to the date-passthrough branch below (not NUMERIC/
 * TEXT/JSON_FIELDS), same as ordered_at/eta/delivered_at.
 */
const EDITABLE_FIELDS = new Set([
  // Spec view
  "name",
  "description",
  "category",
  // "Small round" (6 July 2026) — see doc comment above: sticky
  // identifier, editable but never auto-renumbered. Validated and
  // uniqueness-checked explicitly in PATCH below (NOT run through the
  // generic TEXT_FIELDS/NUMERIC_FIELDS branches further down).
  "item_code",
  "supplier",
  "supplier_email",
  "supplier_contact_id",
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
  "trade_price_received_at",
  "markup_pct",
  "lead_time_weeks",
  "ordered_at",
  "eta",
  "delivered_at",
  // Phase 11 extension — design-phase decision deadline (see doc
  // comment above EDITABLE_FIELDS).
  "decision_needed_by",
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
const FINANCIAL_FIELDS = new Set(["price_trade", "markup_pct", "trade_price_received_at"]);

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

    // item_code: uppercase-trim then validate against ^[A-Z]{2,3}-\d{1,3}$
    // (categories(prefix) is 2-3 letters — see migration 001's categories
    // table — followed by a hyphen and a 1-3 digit sequence number, e.g.
    // "TW-01", "SW-4", "LI-104"). Handled here, separately from
    // TEXT_FIELDS below, since a code needs format validation a plain
    // trim-to-null text field doesn't, and an empty code is rejected
    // outright rather than nulled (see below) — item_code is `not null`
    // in the schema (migration 001) with no empty-string convention
    // anywhere else in this codebase.
    if (key === "item_code") {
      const normalized = typeof raw === "string" ? raw.trim().toUpperCase() : "";
      if (!normalized) {
        return NextResponse.json({ error: "item_code cannot be empty" }, { status: 400 });
      }
      if (!ITEM_CODE_PATTERN.test(normalized)) {
        return NextResponse.json(
          { error: "item_code must look like TW-01 (2-3 letters, hyphen, 1-3 digits)" },
          { status: 400 }
        );
      }
      update.item_code = normalized;
      continue;
    }

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

  // item_code uniqueness — checked explicitly ahead of the write so the
  // caller gets a clean 409 with a clear message, rather than surfacing
  // the raw Postgres unique-violation text from
  // idx_items_project_code_active (migration 001: unique on
  // (project_id, item_code) where deleted_at is null). Scoped to THIS
  // item's own project_id and excludes the item's own current row (a
  // no-op "change" to the same code it already has must not 409 itself).
  if ("item_code" in update) {
    const { data: currentItem } = await supabase
      .from("items")
      .select("project_id")
      .eq("id", id)
      .single();
    if (currentItem) {
      const { data: clash } = await supabase
        .from("items")
        .select("id")
        .eq("project_id", currentItem.project_id)
        .eq("item_code", update.item_code as string)
        .is("deleted_at", null)
        .neq("id", id)
        .maybeSingle();
      if (clash) {
        return NextResponse.json(
          { error: `Item code "${update.item_code}" is already used by another item in this project` },
          { status: 409 }
        );
      }
    }
  }

  // Deliberately NOT renumbering: changing item_code here is a pure
  // rename of this one row. Sibling items' codes are never touched,
  // even when a change creates a "gap" or reorders the apparent
  // sequence (e.g. renaming TW-02 to TW-05 does not shift TW-03/TW-04
  // down). Item codes are referenced by number in exported artefacts
  // that live OUTSIDE this database — the builder PDF schedule already
  // sent to a client, a signed Scope of Works, a supplier purchase
  // order — so a renumbering cascade would silently invalidate
  // cross-references in documents this system can't reach back into
  // and correct. A sticky code that never moves out from under a
  // stale reference is the safer property to guarantee; a genuinely
  // wrong/duplicate code is fixed by editing it directly (this route),
  // not by an automatic resequence.
  const { data: item, error } = await supabase
    .from("items")
    .update(update)
    .eq("id", id)
    .is("deleted_at", null)
    .select()
    .single();

  if (error) {
    // 23505 = unique_violation (belt-and-braces: the pre-check above
    // should already have caught an item_code clash, but a concurrent
    // write between the check and this update is still possible).
    const status = error.code === "23505" ? 409 : error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  if (!item) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  // Selected images must be durable: supplier sites hotlink-block and
  // URLs rot (BUILD-SPEC §Images). If the new selection points at an
  // external host, copy it into our storage now and return the stored
  // URL. ensureStoredImage never throws and updates the item itself;
  // on failure the external URL stays (better than nothing) and the
  // UI will show it broken, prompting a manual upload.
  if (
    typeof update.selected_image_url === "string" &&
    update.selected_image_url
  ) {
    const stored = await ensureStoredImage(
      supabase,
      id,
      update.selected_image_url
    );
    if (stored.url && stored.url !== item.selected_image_url) {
      item.selected_image_url = stored.url;
    }
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
        // Phase 14A error visibility — see lib/report-error.ts, admin
        // Settings "System health".
        await reportError("monday-sync", err);
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
