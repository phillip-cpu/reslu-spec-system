import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  buildContractSnapshot,
  cleanLineItems,
  computeTotals,
  inclusiveToExclusive,
  nextInvoiceNumber,
} from "@/lib/client-invoices";
import type {
  ClientApprovedVariation,
  ClientBillingProfile,
  ClientContractSnapshot,
  ClientInvoice,
  ClientInvoiceKind,
  ClientPaymentScheduleItem,
  ClientInvoiceStatus,
  ClientInvoicesListResponse,
  CreateClientInvoiceInput,
} from "@/types/client-invoices";

export const runtime = "nodejs";

const KINDS: ClientInvoiceKind[] = ["design_fee", "other"];

/**
 * GET /api/projects/[id]/client-invoices
 * Admin-only, financial (mirrors GET /api/projects/[id]/invoices — the
 * supplier queue's exact gating shape). Response:
 * { invoices: ClientInvoice[] }, newest first. This is the "Client
 * invoices" section of the project Invoices tab — money IN, distinct
 * from the supplier `invoices` queue (money OUT) on the same page.
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
    return NextResponse.json({ error: "Only admins can access client invoices" }, { status: 403 });
  }

  const [
    { data: invoices, error },
    { data: billingProfile },
    { data: paymentSchedule },
    { data: variations },
  ] = await Promise.all([
    supabase
      .from("client_invoices")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("created_at", { ascending: false }),
    supabase.from("client_billing_profiles").select("*").eq("project_id", projectId).maybeSingle(),
    supabase
      .from("client_payment_schedule")
      .select("*")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort"),
    supabase
      .from("variations")
      .select("id,var_number,description,cost_ex_gst,updated_at")
      .eq("project_id", projectId)
      .eq("status", "approved")
      .is("deleted_at", null)
      .order("var_number"),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const approvedVariations: ClientApprovedVariation[] = (variations ?? []).map((variation) => ({
    id: variation.id,
    var_number: Number(variation.var_number),
    description: variation.description,
    amount_ex_gst: Number(variation.cost_ex_gst),
    amount_inc_gst: Math.round(Number(variation.cost_ex_gst) * 1.1 * 100) / 100,
    approved_at: variation.updated_at,
  }));
  const payload: ClientInvoicesListResponse = {
    invoices: (invoices ?? []) as ClientInvoice[],
    billing_profile: (billingProfile as ClientBillingProfile | null) ?? null,
    payment_schedule: (paymentSchedule ?? []) as ClientPaymentScheduleItem[],
    approved_variations: approvedVariations,
  };
  return NextResponse.json(payload);
}

/**
 * POST /api/projects/[id]/client-invoices
 * Admin-only. Body: CreateClientInvoiceInput — { kind?, client_name,
 * client_email?, address?, line_items: [{description, amount_ex_gst}],
 * due_days?, notes? }. Phase 1 is manual line items only (no
 * generation from the estimate/progress-claims — future hook, see
 * migration 046's own line_items column comment). invoice_number and
 * subtotal/gst/total are ALWAYS server-computed — never accepted from
 * the client (same "no silent/client-controlled money writes" posture
 * as the existing supplier invoices route). Starts at status='draft';
 * use POST /api/client-invoices/[id]/send to email it (which flips
 * status to 'sent' + sets issued_at).
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
    return NextResponse.json({ error: "Only admins can create client invoices" }, { status: 403 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id,job_number,client_name,client_email,address")
    .eq("id", projectId)
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreateClientInvoiceInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const client_name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  if (!client_name) {
    return NextResponse.json({ error: "client_name is required" }, { status: 400 });
  }

  let kind: ClientInvoiceKind = "design_fee";
  if (body.kind !== undefined) {
    if (!KINDS.includes(body.kind)) {
      return NextResponse.json({ error: "Invalid kind" }, { status: 400 });
    }
    kind = body.kind;
  }

  const scheduleItemId =
    typeof body.payment_schedule_item_id === "string" && body.payment_schedule_item_id
      ? body.payment_schedule_item_id
      : null;
  let billingProfile: ClientBillingProfile | null = null;
  let scheduleItem: ClientPaymentScheduleItem | null = null;
  let contractSnapshot: ClientContractSnapshot = {};

  if (scheduleItemId) {
    const [
      { data: profile },
      { data: selectedSchedule },
      { data: fullSchedule },
      { data: existingInvoices },
      { data: variations },
    ] = await Promise.all([
      supabase.from("client_billing_profiles").select("*").eq("project_id", projectId).maybeSingle(),
      supabase
        .from("client_payment_schedule")
        .select("*")
        .eq("id", scheduleItemId)
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .maybeSingle(),
      supabase
        .from("client_payment_schedule")
        .select("*")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("sort"),
      supabase
        .from("client_invoices")
        .select("*")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .neq("status", "void"),
      supabase
        .from("variations")
        .select("id,var_number,description,cost_ex_gst,updated_at")
        .eq("project_id", projectId)
        .eq("status", "approved")
        .is("deleted_at", null)
        .order("var_number"),
    ]);
    billingProfile = profile as ClientBillingProfile | null;
    scheduleItem = selectedSchedule as ClientPaymentScheduleItem | null;
    if (!billingProfile || !scheduleItem) {
      return NextResponse.json({ error: "The selected package stage was not found" }, { status: 400 });
    }
    if (scheduleItem.client_invoice_id) {
      return NextResponse.json({ error: "This package stage has already been invoiced" }, { status: 409 });
    }
    const approvedVariations: ClientApprovedVariation[] = (variations ?? []).map((variation) => ({
      id: variation.id,
      var_number: Number(variation.var_number),
      description: variation.description,
      amount_ex_gst: Number(variation.cost_ex_gst),
      amount_inc_gst: Math.round(Number(variation.cost_ex_gst) * 1.1 * 100) / 100,
      approved_at: variation.updated_at,
    }));
    contractSnapshot = buildContractSnapshot({
      profile: billingProfile,
      schedule: (fullSchedule ?? []) as ClientPaymentScheduleItem[],
      variations: approvedVariations,
      invoices: (existingInvoices ?? []) as ClientInvoice[],
      currentScheduleItemId: scheduleItem.id,
    });
  }

  const requestedLines = scheduleItem
    ? [{ description: scheduleItem.label, amount_ex_gst: inclusiveToExclusive(scheduleItem.amount_inc_gst) }]
    : body.line_items;
  const line_items = cleanLineItems(requestedLines);
  if (!line_items) {
    return NextResponse.json(
      { error: "line_items must be a non-empty array of { description, amount_ex_gst }" },
      { status: 400 }
    );
  }

  const due_days =
    body.due_days !== undefined && Number.isFinite(Number(body.due_days))
      ? Math.max(0, Math.trunc(Number(body.due_days)))
      : billingProfile?.due_days ?? 14;

  const client_email =
    typeof body.client_email === "string" && body.client_email.trim() ? body.client_email.trim() : null;
  const address = typeof body.address === "string" && body.address.trim() ? body.address.trim() : null;
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  const source = body.source === "manual" ? "manual" : "reslu";
  const manualInvoiceNumber =
    source === "manual" && typeof body.invoice_number === "string"
      ? body.invoice_number.trim().slice(0, 100)
      : "";
  if (source === "manual" && !manualInvoiceNumber) {
    return NextResponse.json(
      { error: "invoice_number is required for a manually recorded invoice" },
      { status: 400 }
    );
  }
  const manualStatus: Extract<ClientInvoiceStatus, "sent" | "paid"> =
    body.status === "paid" ? "paid" : "sent";
  const issuedAt =
    source === "manual" && typeof body.issued_at === "string" && body.issued_at
      ? new Date(body.issued_at)
      : null;
  if (source === "manual" && (!issuedAt || Number.isNaN(issuedAt.getTime()))) {
    return NextResponse.json(
      { error: "A valid issued_at date is required for a manually recorded invoice" },
      { status: 400 }
    );
  }
  const paidAt =
    source === "manual" && manualStatus === "paid" && typeof body.paid_at === "string" && body.paid_at
      ? new Date(body.paid_at)
      : null;
  if (
    source === "manual" &&
    manualStatus === "paid" &&
    (!paidAt || Number.isNaN(paidAt.getTime()))
  ) {
    return NextResponse.json(
      { error: "A valid paid_at date is required when recording a paid invoice" },
      { status: 400 }
    );
  }

  const totals = computeTotals(line_items);

  // Job-number-prefixed numbering races (two concurrent creates for the
  // same project computing the same "next" seq) are handled the same
  // conservative way as lib/job-number.ts's own POST /api/projects: one
  // retry on a unique-constraint clash (23505 on invoice_number).
  let invoice: ClientInvoice | null = null;
  let lastError: { code?: string; message: string } | null = null;
  const attempts = source === "manual" ? 1 : 2;
  for (let attempt = 0; attempt < attempts && !invoice; attempt++) {
    const invoice_number =
      source === "manual"
        ? manualInvoiceNumber
        : await nextInvoiceNumber(supabase, {
            id: project.id,
            job_number: (project as { job_number?: string | null }).job_number ?? null,
          });

    const { data, error } = await supabase
      .from("client_invoices")
      .insert({
        project_id: projectId,
        invoice_number,
        source,
        payment_schedule_item_id: scheduleItem?.id ?? null,
        contract_snapshot: contractSnapshot,
        kind,
        client_name,
        client_email,
        address,
        line_items,
        subtotal_ex_gst: totals.subtotal_ex_gst,
        gst: totals.gst,
        total_inc_gst: totals.total_inc_gst,
        due_days,
        notes,
        status: source === "manual" ? manualStatus : "draft",
        issued_at: issuedAt?.toISOString() ?? null,
        paid_at: paidAt?.toISOString() ?? null,
        created_by: info.userId,
      })
      .select()
      .single();

    if (!error) {
      invoice = data as ClientInvoice;
      break;
    }
    lastError = error;
    if (error.code !== "23505") break;
  }

  if (!invoice) {
    const status = lastError?.code === "23505" ? 409 : 500;
    return NextResponse.json(
      {
        error:
          lastError?.code === "23505" && source === "manual"
            ? "A client invoice with this invoice number already exists."
            : lastError?.message ?? "Could not create invoice",
      },
      { status }
    );
  }

  if (scheduleItem) {
    const snapshotWithInvoice: ClientContractSnapshot = {
      ...contractSnapshot,
      current_claim: {
        ...(contractSnapshot.current_claim ?? {
          label: scheduleItem.label,
          amount_inc_gst: Number(scheduleItem.amount_inc_gst),
        }),
        invoice_number: invoice.invoice_number,
        issued_at: invoice.issued_at,
        paid_at: invoice.paid_at,
        status: invoice.status,
      },
    };
    const { error: snapshotError } = await supabase
      .from("client_invoices")
      .update({ contract_snapshot: snapshotWithInvoice })
      .eq("id", invoice.id);
    if (snapshotError) {
      return NextResponse.json(
        { error: `Invoice created, but its contract statement could not be saved: ${snapshotError.message}` },
        { status: 500 }
      );
    }
    invoice = { ...invoice, contract_snapshot: snapshotWithInvoice };

    const { error: scheduleError } = await supabase
      .from("client_payment_schedule")
      .update({ client_invoice_id: invoice.id })
      .eq("id", scheduleItem.id)
      .is("client_invoice_id", null);
    if (scheduleError) {
      return NextResponse.json(
        { error: `Invoice created, but its payment stage could not be linked: ${scheduleError.message}` },
        { status: 500 }
      );
    }
  }

  return NextResponse.json({ invoice }, { status: 201 });
}
