import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { triageEmails, NON_ACTIONABLE_LABELS, type TriageInput } from "@/lib/second-brain/triage";

export const runtime = "nodejs";

const BATCH_SIZE = 20;

/**
 * GET /api/second-brain/triage — Vercel Cron entry point.
 *
 * RESLU Second Brain, Step 9 (docs/RESLU-second-brain-build-brief.md).
 * Picks up to 20 status='new' emails (per the brief), one batched
 * Haiku call via lib/second-brain/triage.ts. fyi/noise go straight to
 * status='done' (never reach extraction, per the brief); everything
 * else becomes status='triaged' for the extract route to pick up.
 *
 * Auth mirrors every other cron in this build: Bearer CRON_SECRET or
 * an authenticated team session.
 */
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  const isCronCall = !!cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!isCronCall) {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = createServiceRoleClient();

  const { data: emails, error } = await supabase
    .from("emails")
    .select("id,from_addr,subject,clean_text")
    .eq("status", "new")
    .order("received_at", { ascending: true })
    .limit(BATCH_SIZE);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (!emails || emails.length === 0) {
    return NextResponse.json({ triaged: 0, done: 0 });
  }

  let triaged = 0;
  let done = 0;
  let usage: Record<string, unknown> = {};

  try {
    const batchResult = await triageEmails(emails as TriageInput[]);
    usage = batchResult.usage;

    const resultByEmailId = new Map(batchResult.results.map((r) => [r.email_id, r]));

    for (const email of emails) {
      const result = resultByEmailId.get(email.id);
      if (!result) {
        console.error("triage: no result returned for email", email.id);
        continue;
      }
      const isNonActionable = NON_ACTIONABLE_LABELS.includes(result.label);
      const { error: updateError } = await supabase
        .from("emails")
        .update({
          triage_label: result.label,
          triage_confidence: result.confidence,
          status: isNonActionable ? "done" : "triaged",
          processed_at: isNonActionable ? new Date().toISOString() : null,
        })
        .eq("id", email.id);
      if (updateError) {
        console.error("triage: update failed for email", email.id, updateError.message);
        continue;
      }
      if (isNonActionable) done++;
      else triaged++;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown triage error";
    console.error("second-brain/triage failed:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }

  return NextResponse.json({ triaged, done, batch_size: emails.length, usage });
}
