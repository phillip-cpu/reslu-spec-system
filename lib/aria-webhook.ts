// ============================================================
// RESLU Spec System — Aria calendar webhook.
// Phillip, 7 July 2026: push client_events to Aria's OpenClaw gateway
// the instant one is created, so she can sync it to Google Calendar
// without depending on a poll/cron on her side (her own gateway has
// had reliability issues this week — a push means we never rely on
// her scheduled checks actually running).
//
// Fire-and-forget from the caller's app/api/projects/[id]/client-events
// POST handler via next/server's after() (same pattern as
// app/api/items/[id]/route.ts's Monday sync kickoff) — this function
// itself does NOT catch its own errors; the caller wraps it in
// try/catch + reportError() so a delivery failure is logged but never
// surfaces to the team member who just saved the event.
//
// Degrades gracefully like every other optional external integration
// in this codebase (Monday sync, Gmail digest): if ARIA_WEBHOOK_URL /
// ARIA_WEBHOOK_SECRET aren't set yet, this is a silent no-op rather
// than a startup crash — the feature "goes live" the moment both env
// vars are set in Vercel, no redeploy of THIS file required.
// ============================================================

const WEBHOOK_TIMEOUT_MS = 10_000;

export interface ClientEventWebhookPayload {
  id: string;
  project_id: string;
  project_name: string | null;
  title: string;
  starts_at: string;
  ends_at: string | null;
  location: string | null;
  notes: string | null;
}

/**
 * POSTs a `client_event.created` notification to Aria's gateway.
 * No-ops (returns without throwing) when the webhook isn't configured.
 * Otherwise throws on a non-2xx response or network/timeout error —
 * the caller is responsible for catching and logging via reportError().
 */
export async function notifyAriaClientEventCreated(
  event: ClientEventWebhookPayload
): Promise<void> {
  const url = process.env.ARIA_WEBHOOK_URL;
  const secret = process.env.ARIA_WEBHOOK_SECRET;
  if (!url || !secret) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        event: "client_event.created",
        id: event.id,
        project_id: event.project_id,
        project_name: event.project_name,
        title: event.title,
        starts_at: event.starts_at,
        ends_at: event.ends_at,
        location: event.location,
        notes: event.notes,
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`Aria webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}
