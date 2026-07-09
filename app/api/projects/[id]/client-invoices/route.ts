import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { cleanLineItems, computeTotals, nextInvoiceNumber } from "@/lib/client-invoices";
import type {
  ClientInvoice,
  ClientInvoiceKind,
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

  const { data: invoices, error } = await supabase
    .from("client_invoices")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const payload: ClientInvoicesListResponse = { invoices: (invoices ?? []) as ClientInvoice[] };
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

  const line_items = cleanLineItems(body.line_items);
  if (!line_items) {
    return NextResponse.json(
      { error: "line_items must be a non-empty array of { description, amount_ex_gst }" },
      { status: 400 }
    );
  }

  const due_days =
    body.due_days !== undefined && Number.isFinite(Number(body.due_days))
      ? Math.max(0, Math.trunc(Number(body.due_days)))
      : 14;

  const client_email =
    typeof body.client_email === "string" && body.client_email.trim() ? body.client_email.trim() : null;
  const address = typeof body.address === "string" && body.address.trim() ? body.address.trim() : null;
  const notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;

  const totals = computeTotals(line_items);

  // Job-number-prefixed numbering races (two concurrent creates for the
  // same project computing the same "next" seq) are handled the same
  // conservative way as lib/job-number.ts's own POST /api/projects: one
  // retry on a unique-constraint clash (23505 on invoice_number).
  let invoice: ClientInvoice | null = null;
  let lastError: { code?: string; message: string } | null = null;
  for (let attempt = 0; attempt < 2 && !invoice; attempt++) {
    const invoice_number = await nextInvoiceNumber(supabase, {
      id: project.id,
      job_number: (project as { job_number?: string | null }).job_number ?? null,
    });

    const { data, error } = await supabase
      .from("client_invoices")
      .insert({
        project_id: projectId,
        invoice_number,
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
      { error: lastError?.message ?? "Could not create invoice" },
      { status }
    );
  }

  return NextResponse.json({ invoice }, { status: 201 });
}
