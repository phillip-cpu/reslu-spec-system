import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { buildThirteenWeekForecast, summariseProjectCosts, type StuartCostLine, type StuartForecastInvoice } from "@/lib/stuart/forecast";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const service = createServiceRoleClient();
  const { data: connection, error: connectionError } = await service
    .from("xero_connections")
    .select("id")
    .eq("is_active", true)
    .maybeSingle();
  if (connectionError) return NextResponse.json({ error: connectionError.message }, { status: 500 });

  const [findings, feedback, run, cash, invoices, costLines, projects] = await Promise.all([
    service
      .from("stuart_finance_findings")
      .select("id,finding_key,kind,severity,title,detail,source_type,source_id,evidence,confidence,first_seen_at,last_seen_at")
      .eq("status", "open")
      .order("severity", { ascending: false })
      .order("last_seen_at", { ascending: false })
      .limit(200),
    service
      .from("stuart_aria_feedback")
      .select("id,source_email_id,reason,corrected_route,training_rule,created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(100),
    service
      .from("stuart_review_runs")
      .select("id,status,started_at,completed_at,finding_count,feedback_count,error_message")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    service
      .from("xero_cash_snapshots")
      .select("cash_balance,credit_balance,as_of_date,synced_at")
      .eq("connection_id", connection?.id ?? "00000000-0000-0000-0000-000000000000")
      .order("as_of_date", { ascending: false })
      .limit(1)
      .maybeSingle(),
    connection?.id
      ? service
        .from("xero_invoices")
        .select("invoice_type,status,due_date,amount_due")
        .eq("connection_id", connection.id)
      : Promise.resolve({ data: [] as StuartForecastInvoice[], error: null }),
    service
      .from("cost_lines")
      .select("project_id,cost_ex_gst,quoted_to_client_ex_gst,actual_paid_ex_gst")
      .is("deleted_at", null)
      .limit(5000),
    service
      .from("projects")
      .select("id,name,job_number,status")
      .is("deleted_at", null),
  ]);
  const error = findings.error ?? feedback.error ?? run.error ?? cash.error ?? invoices.error ?? costLines.error ?? projects.error;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const projectById = new Map((projects.data ?? []).map((project) => [project.id, project]));
  const commercialHistory = summariseProjectCosts((costLines.data ?? []) as StuartCostLine[])
    .map((summary) => ({ ...summary, project: projectById.get(summary.project_id) ?? null }))
    .sort((a, b) => Math.abs(b.actual_vs_estimated_ex_gst) - Math.abs(a.actual_vs_estimated_ex_gst));
  const generatedAt = new Date().toISOString();
  return NextResponse.json({
    generated_at: generatedAt,
    cash_snapshot: cash.data,
    cash_forecast_13_weeks: buildThirteenWeekForecast(
      cash.data?.cash_balance ?? 0,
      (invoices.data ?? []) as StuartForecastInvoice[],
      generatedAt.slice(0, 10)
    ),
    commercial_history: commercialHistory,
    commercial_history_note: "Actuals are approved supplier costs already allocated to estimate lines; null actuals are not treated as proof of zero cost.",
    latest_review: run.data,
    open_findings: findings.data ?? [],
    aria_feedback: feedback.data ?? [],
    authority: {
      may: ["observe", "classify", "calculate", "forecast", "reconcile", "flag", "recommend", "prepare handovers"],
      may_not: ["move money", "pay suppliers", "issue refunds", "run payroll", "change bank details", "submit tax", "post journals", "delete financial records", "approve final prices"],
    },
  });
}
