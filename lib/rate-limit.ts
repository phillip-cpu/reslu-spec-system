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
