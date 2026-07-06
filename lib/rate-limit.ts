/**
 * Minimal in-memory fixed-window rate limiter for the unauthenticated
 * portal routes (BUILD-SPEC.md §Security: "Rate-limit portal routes").
 *
 * Scope/limits: this is per-server-instance memory. On a single Vercel
 * instance it throttles abusive bursts effectively; across many
 * instances it is best-effort. For Phase 1 that is an acceptable
 * trade-off — the tokens are unguessable (32 random bytes) and the
 * ownership check is the real security boundary. Swap for Upstash/Redis
 * if the portal ever needs hard, cross-instance guarantees.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export function rateLimit(
  key: string,
  limit = 30,
  windowMs = 60_000
): RateLimitResult {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now > bucket.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }

  if (bucket.count >= limit) {
    return {
      ok: false,
      remaining: 0,
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000),
    };
  }

  bucket.count += 1;
  return { ok: true, remaining: limit - bucket.count, retryAfterSeconds: 0 };
}

/**
 * Fix round B — BUILD-SPEC.md §"Phase 14 follow-ups" point 5 (audit
 * backlog, deferred from 14B): "login rate limit". A stricter,
 * dedicated bucket for sign-in attempts (5 per 5 minutes, keyed by
 * client IP + attempted email — so one bad actor guessing many emails
 * from one IP is throttled, and one legitimate user mistyping their
 * own password a few times from a shared/office IP isn't punished for
 * everyone else's attempts on that same IP).
 *
 * NOT WIRED UP in this fix round: this app's ONLY sign-in path is
 * app/(auth)/login/page.tsx, which calls the BROWSER Supabase client's
 * `supabase.auth.signInWithPassword()` directly — there is no Next.js
 * server route or Server Action in between that this in-memory,
 * server-side limiter could attach to. `rateLimit()` only has any
 * effect inside code that actually runs on the server (API routes,
 * Server Components); calling it from a "use client" component would
 * just rate-limit each individual browser tab against itself, which is
 * not a real security boundary. Supabase Auth itself already applies
 * its own server-side rate limiting to signInWithPassword (undocumented
 * exact numbers, but confirmed via Supabase's auth rate-limit docs —
 * see https://supabase.com/docs/guides/platform/going-into-prod#rate-limiting-resource-allocation).
 * This export exists so a FUTURE server-side login route/Server Action
 * (if the login flow is ever moved off the browser client — e.g. to
 * support MFA prompts or audit logging server-side) has a
 * ready-to-use, correctly-scoped limiter to call on its first line,
 * rather than that future work reinventing one. Flagging as
 * NOT-APPLICABLE to wire in today rather than forcing a fake
 * server-side wrapper around a client-only call.
 */
export function loginRateLimit(key: string): RateLimitResult {
  return rateLimit(`login:${key}`, 5, 5 * 60_000);
}
