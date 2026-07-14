import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { recordJobRun } from "@/lib/job-runs";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

type RoutineKind = "daily_review" | "weekly_review";

const ROUTINES: Record<RoutineKind, { objective: string; steps: string[] }> = {
  daily_review: {
    objective: "Proactively identify today's operational risks, commitments and useful next actions.",
    steps: [
      "Call get_context_snapshot before deciding what matters.",
      "Use Second Brain search for the projects, leads, emails or prior decisions relevant to each issue.",
      "Create safe internal brief items, tasks or drafts where useful; do not send, publish, approve, delete or change financial/client commitments without human approval.",
      "Store only durable new lessons with add_brain_note, including source and confidence.",
      "Resolve this queue item with a concise note listing sources checked, actions taken and approvals still needed.",
    ],
  },
  weekly_review: {
    objective: "Synthesize the past week into decisions, patterns, risks and the coming week's priorities.",
    steps: [
      "Call get_context_snapshot, then search Second Brain across projects, leads, emails and memory notes for the week's material changes.",
      "Check for contradictions, stale assumptions, unresolved approvals, overdue follow-ups and recurring operational failures.",
      "Create an internal weekly brief and safe internal tasks; external communications, publishing, ad-budget changes, financial actions and deletions require human approval.",
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
  const { data, error } = await service
    .from("aria_queue")
    .upsert(
      {
        kind,
        payload: { routine: kind, period: periodKey, ...ROUTINES[kind] },
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

  await recordJobRun(service, {
    jobKey: `aria_${kind}_enqueue`,
    status: "succeeded",
    startedAt,
    summary: { queued: !!data, period: periodKey },
  });
  return NextResponse.json({ ok: true, queued: !!data, kind, period: periodKey });
}
