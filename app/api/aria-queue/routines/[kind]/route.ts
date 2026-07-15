import { NextRequest, NextResponse } from "next/server";
import { syncAriaActions, type AriaActionSyncSummary } from "@/lib/aria-actions";
import { getUserRole } from "@/lib/auth";
import { recordJobRun } from "@/lib/job-runs";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RoutineKind = "daily_review" | "weekly_review";

const ROUTINES: Record<RoutineKind, { objective: string; steps: string[] }> = {
  daily_review: {
    objective: "Proactively identify today's operational risks, commitments and useful next actions.",
    steps: [
      "Call get_context_snapshot and get_project_health before deciding what matters.",
      "Review the Phase 5 action-sync summary in this queue payload in order: priority.today, priority.this_week, then priority.monitor. Critical Project Health and booking-delivery exceptions are already represented by deduplicated internal Office tasks; investigate them without creating duplicates.",
      "Use Second Brain search for the projects, leads, emails or prior decisions relevant to each issue.",
      "Process followup_draft and invoice_candidate queue items separately. Follow-up copy must be submitted to the Office approval inbox and never sent before the followup_approved item exists. Invoice candidates may only become proposed supplier invoices awaiting human approval.",
      "Create safe internal brief items or drafts where useful. Aria may propose project-data corrections and client/trade replies, but must not apply, send, publish, approve, delete or change financial/client commitments without human approval.",
      "Store only durable new lessons with add_brain_note, including source and confidence.",
      "Resolve this queue item with a concise note listing sources checked, actions taken and approvals still needed.",
    ],
  },
  weekly_review: {
    objective: "Synthesize the past week into decisions, patterns, risks and the coming week's priorities.",
    steps: [
      "Call get_context_snapshot and get_project_health, then search Second Brain across projects, leads, emails and memory notes for the week's material changes.",
      "Check for contradictions, stale assumptions, unresolved approvals, overdue follow-ups and recurring operational failures. Rank the output as Today, This week and Monitor using the Phase 5 action-sync priority lanes.",
      "Review 30/60/90 Potential Future Lead reminders separately from active pipeline. They remain excluded from pipeline value; draft a check-in only when useful and never send or change stage without approval.",
      "Create an internal weekly brief and safe internal tasks without duplicating Phase 4 Office actions; external communications, publishing, ad-budget changes, financial actions, project-data corrections and deletions require human approval.",
      "Consolidate genuinely reusable knowledge with add_brain_note and preserve provenance.",
      "Resolve this queue item with the synthesis location, actions taken and approvals requested.",
    ],
  },
};

function adelaideDateKey(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Adelaide",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

/**
 * GET /api/aria-queue/routines/daily_review|weekly_review
 *
 * A zero-model Vercel cron inserts a deduplicated routine into Aria's
 * existing durable queue. The Mac mini's cheap queue heartbeat notices
 * it and wakes Aria; the model is never invoked merely to check whether
 * work exists. The queue row remains the routine's audit trail.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ kind: string }> }
) {
  const cronSecret = process.env.CRON_SECRET;
  const isCronCall =
    !!cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const info = await getUserRole(supabase);
    if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (info.role !== "admin") {
      return NextResponse.json({ error: "Only admins can enqueue Aria routines" }, { status: 403 });
    }
  }

  const { kind: rawKind } = await params;
  if (!Object.hasOwn(ROUTINES, rawKind)) {
    return NextResponse.json(
      { error: "kind must be daily_review or weekly_review" },
      { status: 400 }
    );
  }
  const kind = rawKind as RoutineKind;

  const startedAt = new Date();
  const periodKey = adelaideDateKey(startedAt);
  const service = createServiceRoleClient();
  const basePayload = { routine: kind, period: periodKey, ...ROUTINES[kind] };
  const { data, error } = await service
    .from("aria_queue")
    .upsert(
      {
        kind,
        payload: basePayload,
        dedupe_key: `routine:${kind}:${periodKey}`,
        source: "aria-routines-cron",
      },
      { onConflict: "dedupe_key", ignoreDuplicates: true }
    )
    .select("id")
    .maybeSingle();

  if (error) {
    await recordJobRun(service, {
      jobKey: `aria_${kind}_enqueue`,
      status: "failed",
      startedAt,
      error: error.message,
    });
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // The routine row is the once-per-period lock. Only its winning insert
  // runs Phase 4, so duplicate cron/manual calls cannot create duplicate
  // Office actions. A separate admin-only /api/aria-actions/sync endpoint
  // remains available for a deliberate same-day retry after a partial error.
  let actions: AriaActionSyncSummary | null = null;
  let actionError: string | null = null;
  if (data) {
    try {
      actions = await syncAriaActions(service, startedAt);
    } catch (syncError) {
      actionError =
        syncError instanceof Error ? syncError.message : "Phase 4 action sync failed";
    }

    const payload = {
      ...basePayload,
      phase_5_action_sync: actions ?? { error: actionError },
    };
    const { error: payloadError } = await service
      .from("aria_queue")
      .update({ payload })
      .eq("id", data.id);
    if (payloadError) {
      actionError = [actionError, `Could not attach action summary: ${payloadError.message}`]
        .filter(Boolean)
        .join("; ");
    }
  }
  const warnings = [actionError, ...(actions?.errors ?? [])].filter(
    (value): value is string => Boolean(value)
  );

  await recordJobRun(service, {
    jobKey: `aria_${kind}_enqueue`,
    status: warnings.length ? "degraded" : "succeeded",
    startedAt,
    summary: {
      queued: !!data,
      period: periodKey,
      phase_5: actions,
    },
    error: warnings.join("; ") || null,
  });
  return NextResponse.json({
    ok: warnings.length === 0,
    queued: !!data,
    kind,
    period: periodKey,
    phase_5: actions,
    warning: warnings.join("; ") || null,
  });
}
