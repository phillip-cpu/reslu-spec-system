import { createServiceRoleClient } from "@/lib/supabase/server";

/**
 * Phase 14A — zero-dependency error visibility.
 * BUILD-SPEC.md Phase 14 "uptime + error monitoring (Sentry or
 * similar)": this is the zero-dep first step — a tiny helper that
 * writes to the `app_errors` table (migration 022_perf_indexes.sql)
 * from existing catch blocks in the highest-value spots (PDF route,
 * scrape pipeline, Monday sync, Gmail send, signature route), surfaced
 * in the admin Settings "System health" section
 * (components/settings/SystemHealth.tsx). Sentry (or similar) remains
 * the documented upgrade path — see docs/RUNBOOK.md §9 — and is
 * deliberately NOT added as a dependency here (BUILD-SPEC.md: "prefer
 * zero" new deps).
 *
 * Server-only — imports the service-role client directly, so this must
 * never be called from client components (it isn't; every call site is
 * an existing server-side catch block).
 *
 * NEVER throws. A logging helper that can itself crash the catch block
 * it's called from would be worse than no logging at all — every
 * failure mode here (DB unreachable, rate limit, bad input) is
 * swallowed silently, exactly like the codebase's other
 * best-effort/fire-and-forget writes (e.g. lib/images.ts's item update
 * after a successful re-host).
 */

const MAX_STACK_EXCERPT_CHARS = 2000;

// Rate limiting: a crash-looping cron (e.g. Monday sync failing every
// run) must never flood app_errors with thousands of near-identical
// rows before a human even looks at Settings. Keyed on `where_at` (the
// call site name) so one noisy source doesn't suppress logging from an
// unrelated one — same in-memory fixed-window approach as
// lib/rate-limit.ts (this app's existing rate limiter), not reused
// directly since that module's limits/keys are tuned for portal HTTP
// traffic, not server-side error reporting; scoped per-instance,
// best-effort, same trade-off BUILD-SPEC.md already accepts for the
// portal rate limiter.
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const RATE_LIMIT_MAX_PER_WINDOW = 5; // at most 5 inserts per where_at per window

const buckets = new Map<string, { count: number; resetAt: number }>();

function allowedToLog(whereAt: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(whereAt);
  if (!bucket || now > bucket.resetAt) {
    buckets.set(whereAt, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (bucket.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    return false;
  }
  bucket.count += 1;
  return true;
}

/**
 * Records a server-side error to app_errors, rate-limited per call
 * site. Call from a catch block with a short, stable `whereAt` label
 * (e.g. "pdf-route", "scrape-pipeline", "monday-sync", "gmail-send",
 * "signature-route") — NOT a dynamically-built string (a per-item or
 * per-request label would defeat the rate limiter's whole purpose,
 * since every distinct key gets its own budget).
 */
export async function reportError(
  whereAt: string,
  error: unknown
): Promise<void> {
  try {
    if (!allowedToLog(whereAt)) return;

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error";
    const stack =
      error instanceof Error && error.stack
        ? error.stack.slice(0, MAX_STACK_EXCERPT_CHARS)
        : null;

    const supabase = createServiceRoleClient();
    await supabase.from("app_errors").insert({
      where_at: whereAt,
      message: message.slice(0, 2000),
      stack,
    });
  } catch {
    // Logging must never throw into the caller's own catch block.
  }
}
