import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isCronRequest, isStuartUser } from "@/lib/stuart/access";
import {
  reviewAccountsEmails,
  reviewSpecAgainstXero,
  reviewXeroInvoices,
  type AccountsEmailReviewRow,
  type SpecInvoiceReviewRow,
  type StuartFinding,
  type XeroInvoiceReviewRow,
} from "@/lib/stuart/review";
import { syncXeroReadModel } from "@/lib/xero/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function authorised(request: NextRequest) {
  if (isCronRequest(request.headers.get("authorization"))) return { allowed: true, userId: null };
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  return { allowed: isStuartUser(user), userId: user?.id ?? null };
}

function dateDaysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function runReview(triggeredBy: string | null) {
  const service = createServiceRoleClient();
  const startedAt = new Date().toISOString();
  if (!triggeredBy) {
    const { data: stuart } = await service
      .from("conversation_agents")
      .select("auth_profile_id")
      .eq("slug", "stuart")
      .maybeSingle();
    triggeredBy = stuart?.auth_profile_id ?? null;
  }
  const { data: run, error: runError } = await service
    .from("stuart_review_runs")
    .insert({ status: "running", triggered_by: triggeredBy, started_at: startedAt })
    .select("id")
    .single();
  if (runError || !run) throw new Error(runError?.message ?? "Could not start Stuart review");

  try {
    let xeroSyncWarning: string | null = null;
    if (triggeredBy && process.env.STUART_XERO_SYNC_ENABLED !== "false") {
      try {
        await syncXeroReadModel(triggeredBy);
      } catch (error) {
        xeroSyncWarning = error instanceof Error ? error.message : "Xero refresh failed";
      }
    }

    const { data: connection } = await service
      .from("xero_connections")
      .select("id,last_sync_completed_at")
      .eq("is_active", true)
      .maybeSingle();
    const connectionId = connection?.id ?? null;
    const [xeroResult, supplierResult, clientResult, emailResult] = await Promise.all([
      connectionId
        ? service
          .from("xero_invoices")
          .select("xero_invoice_id,invoice_type,status,invoice_number,contact_name,due_date,total,amount_due")
          .eq("connection_id", connectionId)
        : Promise.resolve({ data: [] as XeroInvoiceReviewRow[], error: null }),
      service
        .from("invoices")
        .select("id,invoice_number,supplier,total,status,source_email_id,storage_path")
        .neq("status", "rejected"),
      service
        .from("client_invoices")
        .select("id,invoice_number,client_name,total_inc_gst,status")
        .is("deleted_at", null),
      service
        .from("emails")
        .select("id,from_addr,subject,clean_text,received_at,triage_label,ingested_mailboxes,email_attachments(filename,extracted_text)")
        .contains("ingested_mailboxes", ["accounts@reslu.com.au"])
        .gte("received_at", dateDaysAgo(120))
        .order("received_at", { ascending: false })
        .limit(1000),
    ]);
    const readError = xeroResult.error ?? supplierResult.error ?? clientResult.error ?? emailResult.error;
    if (readError) throw new Error(readError.message);

    const now = new Date().toISOString();
    const today = now.slice(0, 10);
    const xeroRows = (xeroResult.data ?? []) as XeroInvoiceReviewRow[];
    const supplierRows = (supplierResult.data ?? []) as SpecInvoiceReviewRow[];
    const clientRows = (clientResult.data ?? []) as SpecInvoiceReviewRow[];
    const emailRows = (emailResult.data ?? []) as unknown as AccountsEmailReviewRow[];
    const linkedEmailIds = new Set(supplierRows.flatMap((row) => row.source_email_id ? [row.source_email_id] : []));
    const emailReview = reviewAccountsEmails(emailRows, linkedEmailIds, now);
    const findings: StuartFinding[] = [
      ...reviewXeroInvoices(xeroRows, today, now),
      ...reviewSpecAgainstXero(supplierRows, xeroRows, "ACCPAY", now),
      ...reviewSpecAgainstXero(clientRows, xeroRows, "ACCREC", now),
      ...emailReview.findings,
    ];
    if (!connectionId) {
      findings.push({
        finding_key: "system:xero:not-connected",
        kind: "forecast_risk",
        severity: "urgent",
        title: "Xero is not connected",
        detail: "Stuart cannot verify invoices, payments or current cash until the read-only Xero connection is available.",
        source_type: "system",
        source_id: null,
        evidence: {},
        confidence: "high",
        last_seen_at: now,
      });
    } else if (xeroSyncWarning) {
      findings.push({
        finding_key: "system:xero:sync-warning",
        kind: "forecast_risk",
        severity: "warning",
        title: "Xero refresh did not complete",
        detail: "Stuart used the last successful read-only cache. A human should inspect the Xero connection if this repeats.",
        source_type: "xero_sync",
        source_id: connectionId,
        evidence: { last_sync_completed_at: connection?.last_sync_completed_at ?? null, safe_error: xeroSyncWarning },
        confidence: "high",
        last_seen_at: now,
      });
    }

    if (findings.length > 0) {
      const { error } = await service.from("stuart_finance_findings").upsert(findings, { onConflict: "finding_key" });
      if (error) throw new Error(error.message);
    }
    if (emailReview.feedback.length > 0) {
      const { error } = await service.from("stuart_aria_feedback").upsert(emailReview.feedback, {
        onConflict: "source_email_id",
        ignoreDuplicates: true,
      });
      if (error) throw new Error(error.message);
      const { data: savedFeedback, error: feedbackReadError } = await service
        .from("stuart_aria_feedback")
        .select("id,source_email_id,reason,corrected_route,training_rule")
        .in("source_email_id", emailReview.feedback.map((item) => item.source_email_id));
      if (feedbackReadError) throw new Error(feedbackReadError.message);
      const feedbackByEmail = new Map(emailReview.feedback.map((item) => [item.source_email_id, item]));
      const queueRows = (savedFeedback ?? []).map((row) => {
        const feedback = feedbackByEmail.get(row.source_email_id) ?? row;
        return {
          kind: "finance_routing_feedback",
          source: "stuart-finance-review",
          dedupe_key: `stuart-finance-routing:${row.source_email_id}`,
          payload: {
            stuart_feedback_id: row.id,
            source_email_id: row.source_email_id,
            reason: feedback.reason,
            corrected_route: feedback.corrected_route,
            training_rule: feedback.training_rule,
            instruction: "Review this correction and apply the routing rule to future Accounts forwards. Do not reply to the original external sender.",
          },
        };
      });
      if (queueRows.length > 0) {
        const { error: queueError } = await service.from("aria_queue").upsert(queueRows, {
          onConflict: "dedupe_key",
          ignoreDuplicates: true,
        });
        if (queueError) throw new Error(queueError.message);
      }
    }

    // Current Xero/Spec findings disappear only when a later complete review
    // proves the condition is gone. Email evidence remains open until handled.
    await service
      .from("stuart_finance_findings")
      .update({ status: "resolved", resolved_at: now })
      .eq("status", "open")
      .in("source_type", ["xero_invoice", "supplier_invoice", "client_invoice", "xero_sync", "system"])
      .lt("last_seen_at", startedAt);

    await service.from("stuart_review_runs").update({
      status: "completed",
      completed_at: now,
      finding_count: findings.length,
      feedback_count: emailReview.feedback.length,
    }).eq("id", run.id);
    return { run_id: run.id, findings: findings.length, aria_feedback: emailReview.feedback.length, xero_sync_warning: xeroSyncWarning };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Stuart review failed";
    await service.from("stuart_review_runs").update({ status: "failed", completed_at: new Date().toISOString(), error_message: message }).eq("id", run.id);
    throw error;
  }
}

export async function GET(request: NextRequest) {
  const access = await authorised(request);
  if (!access.allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    return NextResponse.json(await runReview(access.userId));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Stuart review failed" }, { status: 500 });
  }
}

export const POST = GET;
