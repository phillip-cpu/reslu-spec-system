import type { SupabaseClient } from "@supabase/supabase-js";
import type { AriaActivityItem, AriaActivityResponse } from "@/types/aria-activity";

const LABELS: Record<string, string> = {
  daily_review: "Daily review",
  weekly_review: "Weekly review",
  calendar_sync: "Trade calendar update",
  invoice_candidate: "Invoice review",
  followup_draft: "Lead follow-up draft",
  followup_approved: "Approved follow-up send",
  meeting_transcription: "Meeting transcription",
  price_request: "Price request",
  trade_reminder: "Trade reminder",
  lead_flag: "Lead review",
  approval_needed: "Approval needed",
  email_proposal: "Email proposal",
  draft_proposal: "Proposal draft",
};

function payloadDetail(payload: Record<string, unknown>, error: string | null): string | null {
  if (error) return error;
  for (const key of ["project_name", "lead_name", "filename", "title", "instruction"]) {
    if (typeof payload[key] === "string" && payload[key].trim()) return payload[key].trim().slice(0, 180);
  }
  return null;
}

export async function loadAriaActivity(
  supabase: SupabaseClient,
  now = new Date()
): Promise<AriaActivityResponse> {
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const abandonedBefore = new Date(now.getTime() - 15 * 60 * 1000).getTime();

  const [{ data: queueRows }, { count: followupCount }, { count: invoiceCount }] = await Promise.all([
    supabase
      .from("aria_queue")
      .select("id,kind,status,payload,created_at,picked_up_at,resolved_at,attempts,error")
      .order("created_at", { ascending: false })
      .limit(40),
    supabase
      .from("aria_followup_drafts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending"),
    supabase
      .from("invoices")
      .select("id", { count: "exact", head: true })
      .eq("source", "aria")
      .in("status", ["unmatched", "proposed"]),
  ]);

  const items: AriaActivityItem[] = (queueRows ?? []).map((row) => {
    const status = row.status as AriaActivityItem["status"];
    const staleClaim =
      status === "picked_up" &&
      !!row.picked_up_at &&
      new Date(row.picked_up_at).getTime() < abandonedBefore;
    return {
      id: row.id,
      kind: row.kind,
      status,
      title: LABELS[row.kind] ?? row.kind.replaceAll("_", " "),
      detail: payloadDetail((row.payload ?? {}) as Record<string, unknown>, row.error),
      created_at: row.created_at,
      picked_up_at: row.picked_up_at,
      resolved_at: row.resolved_at,
      attempts: row.attempts,
      is_exception: status === "failed" || staleClaim,
    };
  });

  return {
    summary: {
      waiting: items.filter((item) => item.status === "pending").length,
      working: items.filter((item) => item.status === "picked_up" && !item.is_exception).length,
      failed_7d: items.filter(
        (item) => item.status === "failed" && (item.resolved_at ?? item.created_at) >= sevenDaysAgo
      ).length,
      approvals: (followupCount ?? 0) + (invoiceCount ?? 0),
    },
    items,
  };
}

