import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import { validateUploadBytes } from "@/lib/file-sniff";
import { sendPushToAdmins } from "@/lib/push";
import type { CreateInvoiceResponse, Invoice, InvoiceMatchType, InvoiceStatus } from "@/types";
import type { InvoiceSource, InvoiceWithIntake, SupplierInvoiceExtracted } from "@/types/round-supplier-invoice-intake";

export const runtime = "nodejs";

const STATUSES: InvoiceStatus[] = ["unmatched", "proposed", "approved", "rejected"];
const MATCH_TYPES: InvoiceMatchType[] = ["cost_line", "item"];
const SOURCES: InvoiceSource[] = ["manual", "aria"];

/**
 * GET /api/projects/[id]/invoices?status=
 * Admin-only, financial (BUILD-SPEC.md "Invoice pipeline" +
 * "Financial visibility — role-gated": invoice amounts are exactly the
 * kind of pricing data non-admins never see). Whole-route 403, same
 * shape as app/api/projects/[id]/estimate/route.ts — nothing is
 * queried before the role check.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access invoices" },
      { status: 403 }
    );
  }

  const statusFilter = request.nextUrl.searchParams.get("status");
  if (statusFilter && !STATUSES.includes(statusFilter as InvoiceStatus)) {
    return NextResponse.json({ error: "Invalid status filter" }, { status: 400 });
  }

  let query = supabase
    .from("invoices")
    .select("*")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (statusFilter) {
    query = query.eq("status", statusFilter);
  }

  const { data: invoices, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ invoices: invoices as InvoiceWithIntake[] });
}

/**
 * POST /api/projects/[id]/invoices
 * Accepts either JSON metadata (Aria posting programmatically — no
 * file, BUILD-SPEC.md "Agent control — Aria": "Every UI capability
 * must therefore have an API route") or multipart form-data with an
 * optional `file` field (manual upload via the queue UI). Mirrors
 * app/api/items/[id]/files/route.ts's upload pattern for the file half
 * (same bucket, upload-then-insert-then-cleanup-on-failure shape).
 *
 * Duplicate warn (not hard block): if a non-rejected invoice already
 * exists for (project, supplier, invoice_number) — mirroring the
 * partial unique index idx_invoices_project_supplier_number_live from
 * 007_estimating.sql — the new invoice is still created (v1: "AI
 * proposes, admin approves — no silent money writes", not "reject
 * duplicates"), and the existing one is returned alongside it as
 * `duplicate_warning` so the queue UI/Aria can flag it for review.
 *
 * Booking selection v2 + Aria supplier invoices (r24), item 5: the MCP
 * `propose_supplier_invoice` tool is a thin caller of THIS SAME route
 * (JSON branch) with `source: 'aria'`, `source_email_id` (the
 * ALREADY-INGESTED Second Brain email this was extracted from), and
 * `extracted` (Aria's raw read of the PDF — supplier/ABN/date/totals/
 * line hints/job hints, migration 052's jsonb column). This is the
 * DRAFT-ONLY hard rule in code, not just policy: this handler only ever
 * INSERTs a row — nothing here (or anywhere reachable from it) applies
 * a cost, writes an item/cost_line, or touches `library_items`. The
 * only path that ever does that is POST /api/invoices/[id]/approve,
 * which requires a human's explicit action in the queue UI. A row
 * created with `proposed_match_type`/`proposed_match_id` already set
 * (Aria always proposes a match) starts at status='proposed' — combined
 * with source='aria' this is exactly the "Aria · needs approval"
 * sand/amber pill (item 6), a pure display derivation, no new status
 * value (see migration 052's header comment).
 *
 * Aria proposing an invoice ALSO raises a dedupe-guarded
 * daily_brief_items row (source='invoice' — already a valid value,
 * reserved for this round by 041_brief_and_due_times.sql, see migration
 * 052's header) so it surfaces on the Daily Brief the same day, not
 * just silently in the queue — same "existing open row" dedupe shape as
 * POST /api/proposal/[token]/accept's own daily_brief_items insert
 * (check source+link_href+title+status='open' before inserting).
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can create invoices" },
      { status: 403 }
    );
  }

  const contentType = request.headers.get("content-type") ?? "";
  let body: Record<string, unknown>;
  let file: File | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData().catch(() => null);
    if (!form) {
      return NextResponse.json({ error: "Expected form data" }, { status: 400 });
    }
    const maybeFile = form.get("file");
    file = maybeFile instanceof File ? maybeFile : null;
    body = {};
    for (const key of [
      "supplier",
      "invoice_number",
      "invoice_date",
      "amount_ex_gst",
      "gst",
      "total",
      "proposed_match_type",
      "proposed_match_id",
      "confidence_note",
    ]) {
      const v = form.get(key);
      if (v !== null) body[key] = v;
    }
  } else {
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }
  }

  const supplier = typeof body.supplier === "string" ? body.supplier.trim() : "";
  const invoice_number =
    typeof body.invoice_number === "string" ? body.invoice_number.trim() : "";
  const amount_ex_gst = Number(body.amount_ex_gst);

  if (!supplier) {
    return NextResponse.json({ error: "supplier is required" }, { status: 400 });
  }
  if (!invoice_number) {
    return NextResponse.json({ error: "invoice_number is required" }, { status: 400 });
  }
  if (!Number.isFinite(amount_ex_gst)) {
    return NextResponse.json({ error: "amount_ex_gst must be a number" }, { status: 400 });
  }

  const gst = body.gst !== undefined ? Number(body.gst) : roundToCents(amount_ex_gst * 0.1);
  if (!Number.isFinite(gst)) {
    return NextResponse.json({ error: "gst must be a number" }, { status: 400 });
  }
  const total = body.total !== undefined ? Number(body.total) : roundToCents(amount_ex_gst + gst);
  if (!Number.isFinite(total)) {
    return NextResponse.json({ error: "total must be a number" }, { status: 400 });
  }

  let proposed_match_type: InvoiceMatchType | null = null;
  if (body.proposed_match_type !== undefined && body.proposed_match_type !== null && body.proposed_match_type !== "") {
    const mt = String(body.proposed_match_type);
    if (!MATCH_TYPES.includes(mt as InvoiceMatchType)) {
      return NextResponse.json({ error: "Invalid proposed_match_type" }, { status: 400 });
    }
    proposed_match_type = mt as InvoiceMatchType;
  }
  const proposed_match_id =
    typeof body.proposed_match_id === "string" && body.proposed_match_id ? body.proposed_match_id : null;

  if ((proposed_match_type && !proposed_match_id) || (!proposed_match_type && proposed_match_id)) {
    return NextResponse.json(
      { error: "proposed_match_type and proposed_match_id must be set together" },
      { status: 400 }
    );
  }

  const invoice_date =
    typeof body.invoice_date === "string" && body.invoice_date ? body.invoice_date : null;
  const confidence_note =
    typeof body.confidence_note === "string" && body.confidence_note ? body.confidence_note : null;

  // Booking selection v2 + Aria supplier invoices (r24) — source/
  // source_email_id/extracted (migration 052). JSON branch only — the
  // manual UploadForm's multipart request never sends these, so a
  // manual upload always lands source='manual' (the column default),
  // source_email_id null, extracted null.
  let source: InvoiceSource = "manual";
  if (body.source !== undefined && body.source !== null && body.source !== "") {
    const s = String(body.source);
    if (!SOURCES.includes(s as InvoiceSource)) {
      return NextResponse.json({ error: "Invalid source" }, { status: 400 });
    }
    source = s as InvoiceSource;
  }
  const source_email_id =
    typeof body.source_email_id === "string" && body.source_email_id ? body.source_email_id : null;
  if (source === "aria" && !source_email_id) {
    return NextResponse.json(
      { error: "source_email_id is required when source is 'aria' — every Aria-proposed invoice must trace back to the email it was extracted from" },
      { status: 400 }
    );
  }
  let extracted: SupplierInvoiceExtracted | null = null;
  if (body.extracted !== undefined && body.extracted !== null) {
    if (typeof body.extracted !== "object" || Array.isArray(body.extracted)) {
      return NextResponse.json({ error: "extracted must be an object" }, { status: 400 });
    }
    extracted = body.extracted as SupplierInvoiceExtracted;
  }

  // Duplicate check (warn, not block) — same key as the partial unique
  // index (project_id, supplier, invoice_number) where status != 'rejected'.
  const { data: existing } = await supabase
    .from("invoices")
    .select("*")
    .eq("project_id", projectId)
    .eq("supplier", supplier)
    .eq("invoice_number", invoice_number)
    .neq("status", "rejected")
    .maybeSingle();

  let storage_path: string | null = null;
  if (file) {
    const filename = file.name || "invoice";
    const path = `projects/${projectId}/invoices/${Date.now()}-${slugFilename(filename)}`;
    const bytes = Buffer.from(await file.arrayBuffer());

    // Fix round B — BUILD-SPEC.md §"Phase 14 follow-ups" point 5:
    // magic-byte validation. Invoices are typically PDFs (occasionally
    // an image of a receipt) — reject an obvious content/label
    // mismatch before it ever reaches Storage.
    const sniffResult = validateUploadBytes(bytes, file.type || "");
    if (!sniffResult.ok) {
      return NextResponse.json({ error: sniffResult.error }, { status: 400 });
    }

    const { error: uploadError } = await supabase.storage
      .from(ASSET_BUCKET)
      .upload(path, bytes, {
        contentType: file.type || "application/octet-stream",
        upsert: false,
      });
    if (uploadError) {
      return NextResponse.json(
        { error: `Storage: ${uploadError.message}. If this mentions a missing bucket, run migration 009.` },
        { status: 500 }
      );
    }
    storage_path = path;
  }

  const insertBody: Record<string, unknown> = {
    project_id: projectId,
    supplier,
    invoice_number,
    invoice_date,
    amount_ex_gst,
    gst,
    total,
    storage_path,
    proposed_match_type,
    proposed_match_id,
    confidence_note,
    created_by: info.userId,
    source,
    source_email_id,
    extracted,
  };
  // proposed_match_type/id set at creation time means a match is
  // already proposed (e.g. Aria posting with high-confidence
  // extraction) — start the row at 'proposed' rather than 'unmatched'
  // so it doesn't need a separate PATCH just to flip status.
  if (proposed_match_type) {
    insertBody.status = "proposed";
  }

  const { data: invoice, error: insertError } = await supabase
    .from("invoices")
    .insert(insertBody)
    .select()
    .single();

  if (insertError) {
    if (storage_path) {
      await supabase.storage.from(ASSET_BUCKET).remove([storage_path]);
    }
    // 23505 shouldn't normally fire here since we warn rather than
    // block, but the unique index only excludes 'rejected' — a
    // concurrent insert of the exact same (project, supplier, number)
    // between our check and this insert could still race. Surface it
    // as a 409 rather than a raw 500 in that edge case.
    const status = insertError.code === "23505" ? 409 : 500;
    return NextResponse.json({ error: insertError.message }, { status });
  }

  // Booking selection v2 + Aria supplier invoices (r24), item 5:
  // dedupe-guarded Daily Brief surfacing — same "check for an existing
  // OPEN row with this source+link_href+title, only insert if none
  // found" shape as POST /api/proposal/[token]/accept's own
  // daily_brief_items insert (that route's doc comment). source='invoice'
  // is already a valid daily_brief_items.source value (reserved by
  // 041_brief_and_due_times.sql — see migration 052's header comment),
  // so no schema change was needed for this half of the round.
  if (source === "aria") {
    const briefTitle = `Aria flagged a supplier invoice — ${supplier} #${invoice_number}`;
    const briefLink = `/projects/${projectId}/invoices`;
    const { data: existingBriefItem } = await supabase
      .from("daily_brief_items")
      .select("id")
      .eq("source", "invoice")
      .eq("link_href", briefLink)
      .eq("title", briefTitle)
      .eq("status", "open")
      .maybeSingle();
    if (!existingBriefItem) {
      await supabase.from("daily_brief_items").insert({
        title: briefTitle,
        source: "invoice",
        link_href: briefLink,
        status: "open",
        created_by_kind: "aria",
        project_id: projectId,
      });
    }

    // BUILD-SPEC.md r27 item 11 — "Supplier invoice push: Aria intake
    // insert also fires sendPushToAdmins + notifications row." Same
    // shape as every other r26 trigger site (r20 respond route, r23
    // accept route, health incident routes): insert a notifications row
    // (user_id null = all-admins) THEN sendPushToAdmins with the
    // identical fields — see lib/push.ts's own doc comment on that
    // call-site convention. Deliberately a fresh notification on EVERY
    // Aria-flagged invoice, not the dedupe-guarded notifyAdminsOnce()
    // (that helper is for a recurring "still open?" incident condition
    // — a health channel down, a missed cron; each flagged invoice here
    // is a genuinely new, distinct event, same reasoning the r20/r23
    // trigger sites already document for themselves). Best-effort —
    // never blocks the invoice creation, which already committed above.
    try {
      await supabase.from("notifications").insert({
        user_id: null,
        kind: "supplier_invoice_flagged",
        title: briefTitle,
        body: null,
        link_href: briefLink,
      });
      await sendPushToAdmins("supplier_invoice_flagged", briefTitle, "", briefLink);
    } catch (pushError) {
      console.error("projects/[id]/invoices: push notify failed (non-fatal)", pushError);
    }
  }

  const payload: CreateInvoiceResponse = { invoice: invoice as Invoice };
  if (existing) {
    payload.duplicate_warning = existing as Invoice;
  }

  return NextResponse.json(payload, { status: 201 });
}

function roundToCents(value: number): number {
  // Same fix as lib/client-invoices.ts's roundHalfUpCents() — a fixed
  // Number.EPSILON nudge doesn't correct the float representation
  // error introduced BY the *100 multiplication itself (e.g. 40.15*100
  // can land on 4014.999999999999). .toFixed(8) resolves that noise
  // via a correctly-rounded decimal conversion before the real
  // half-up rounding. Found via review of the client-invoices round,
  // which copied this function verbatim — same bug existed here too.
  const cents = Number((value * 100).toFixed(8));
  return Math.round(cents) / 100;
}
