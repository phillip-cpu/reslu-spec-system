import { NextRequest, NextResponse } from "next/server";
import { payloadSha256 } from "@/lib/aria-authority";
import {
  prepareCompanyOverheadIntake,
  type CompanyOverheadIntake,
} from "@/lib/finance/company-overhead-intake";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

const TOOL_NAME = "commit_company_overhead_finance_intake";

function samePacket(left: CompanyOverheadIntake, right: CompanyOverheadIntake): boolean {
  return payloadSha256(left) === payloadSha256(right);
}

/**
 * Consequential half of the company-overhead intake workflow. The MCP
 * authority layer must create an executing R2 action run from Phillip's exact
 * task-artifact approval before this route can write the Cockpit draft.
 */
export async function POST(request: NextRequest) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: CompanyOverheadIntake;
  try { body = await request.json() as CompanyOverheadIntake; }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const service = createServiceRoleClient();
  const digest = payloadSha256(body);
  const { data: actionRun } = await service
    .from("aria_action_runs")
    .select("id,approval_receipt_id")
    .eq("tool_name", TOOL_NAME)
    .eq("actor_profile_id", user.id)
    .eq("payload_sha256", digest)
    .eq("state", "executing")
    .not("approval_receipt_id", "is", null)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!actionRun?.approval_receipt_id) {
    return NextResponse.json(
      { error: "Phillip's exact, unexpired approval receipt is required" },
      { status: 403 }
    );
  }

  const { data: approval } = await service
    .from("aria_approval_receipts")
    .select("id,approved_by,expires_at,revoked_at")
    .eq("id", actionRun.approval_receipt_id)
    .eq("tool_name", TOOL_NAME)
    .maybeSingle();
  if (!approval || approval.revoked_at || new Date(approval.expires_at) <= new Date()) {
    return NextResponse.json({ error: "Approval receipt is expired or revoked" }, { status: 403 });
  }

  const [{ data: email }, { data: attachment }] = await Promise.all([
    service.from("emails")
      .select("id,subject,triage_label,matched_project_id,ingested_mailboxes,extraction")
      .eq("id", body.source_email_id).maybeSingle(),
    service.from("email_attachments")
      .select("id,email_id,filename,mime")
      .eq("id", body.source_attachment_id).maybeSingle(),
  ]);
  if (!email || !attachment || attachment.email_id !== email.id) {
    return NextResponse.json({ error: "Source email or attachment is missing" }, { status: 409 });
  }

  const extraction = (email.extraction ?? {}) as Record<string, unknown>;
  const candidate = (extraction.supplier_invoice ?? {}) as Record<string, unknown>;
  const jobMentions = Array.isArray(extraction.job_mentions)
    ? extraction.job_mentions.map((value) =>
        typeof value === "string" ? value : String((value as Record<string, unknown>)?.text ?? "")
      ).filter(Boolean)
    : [];
  const prepared = prepareCompanyOverheadIntake({
    source_email_id: email.id,
    source_attachment_id: attachment.id,
    ingested_mailboxes: email.ingested_mailboxes ?? [],
    triage_label: email.triage_label,
    matched_project_id: email.matched_project_id,
    supplier: typeof candidate.supplier === "string" ? candidate.supplier : null,
    invoice_date: typeof candidate.invoice_date === "string" ? candidate.invoice_date : null,
    amount_ex_gst: typeof candidate.amount_ex_gst === "number" ? candidate.amount_ex_gst : null,
    gst: typeof candidate.gst === "number" ? candidate.gst : null,
    total: typeof candidate.total === "number" ? candidate.total : null,
    currency_code: typeof candidate.currency_code === "string" ? candidate.currency_code : "AUD",
    job_hints: typeof candidate.job_hints === "string" ? candidate.job_hints : null,
    job_mentions: jobMentions,
    subject: email.subject,
    line_hints: typeof candidate.line_hints === "string" ? candidate.line_hints : null,
    attachment_filename: attachment.filename,
    attachment_mime: attachment.mime,
  });
  if (!prepared.eligible) {
    return NextResponse.json({ error: prepared.reason }, { status: 409 });
  }
  if (!samePacket(prepared.intake, body)) {
    return NextResponse.json(
      { error: "Source evidence changed after approval; prepare a new exact approval artifact" },
      { status: 409 }
    );
  }

  const { data: existing } = await service
    .from("finance_recurring_commitments")
    .select("*")
    .or(`source_email_id.eq.${body.source_email_id},overhead_duplicate_key.eq.${body.duplicate_key}`)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({ commitment: existing, created: false, duplicate_prevented: true });
  }

  const notes = [
    `Company-overhead finance intake from Second Brain email ${body.source_email_id}.`,
    `Source attachment ${body.source_attachment_id}.`,
    `Ex GST ${body.amount_ex_gst_minor}; GST ${body.gst_minor}; total ${body.total_minor} minor units.`,
    "No Spec project allocation. Accounts routing is an approved internal artifact; no email was sent by this action.",
  ].join(" ");
  const { data: commitment, error: insertError } = await service
    .from("finance_recurring_commitments")
    .insert({
      name: `${body.supplier} — ${body.invoice_date}`.slice(0, 120),
      category: body.category,
      supplier_or_payee: body.supplier,
      amount_minor: body.total_minor,
      frequency: "once",
      first_due_date: body.invoice_date,
      end_date: null,
      gst_treatment: body.gst_minor > 0 ? "inclusive" : "gst_free",
      annual_escalation_bps: 0,
      confidence: "confirmed",
      status: "draft",
      notes,
      created_by: approval.approved_by,
      updated_by: approval.approved_by,
      source_email_id: body.source_email_id,
      source_attachment_id: body.source_attachment_id,
      overhead_duplicate_key: body.duplicate_key,
      approval_receipt_id: approval.id,
    })
    .select("*")
    .single();
  if (insertError || !commitment) {
    if (insertError?.code === "23505") {
      return NextResponse.json({ error: "Duplicate company-overhead intake was prevented" }, { status: 409 });
    }
    return NextResponse.json({ error: insertError?.message ?? "Could not create Cockpit draft" }, { status: 500 });
  }

  const { error: auditError } = await service.from("finance_audit_events").insert({
    actor_id: approval.approved_by,
    source: "company_overhead_finance_intake",
    action: "create_draft",
    object_type: "finance_recurring_commitment",
    object_id: commitment.id,
    payload: {
      approval_receipt_id: approval.id,
      source_email_id: body.source_email_id,
      source_attachment_id: body.source_attachment_id,
      duplicate_key: body.duplicate_key,
      expense_scope: "company",
      project_id: null,
      route_to: body.route_to,
      email_sent: false,
    },
  });
  if (auditError) {
    const { error: rollbackError } = await service
      .from("finance_recurring_commitments")
      .delete()
      .eq("id", commitment.id)
      .eq("status", "draft")
      .eq("approval_receipt_id", approval.id);
    return NextResponse.json(
      {
        error: rollbackError
          ? `Audit failed and draft rollback also failed: ${auditError.message}; ${rollbackError.message}`
          : `Audit failed, so the new Cockpit draft was rolled back: ${auditError.message}`,
      },
      { status: 500 }
    );
  }

  return NextResponse.json({
    commitment,
    created: true,
    accounts_routing: {
      to: "accounts@reslu.com.au",
      source_email_id: body.source_email_id,
      source_attachment_id: body.source_attachment_id,
      status: "approved_internal_artifact",
      email_sent: false,
    },
  });
}
