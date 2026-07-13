import { createPrivateKey, sign } from "node:crypto";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/report-error";

// ============================================================
// RESLU Spec System — Health + web push (r26)
// BUILD-SPEC.md item 2: "Web push WITHOUT new npm deps: check
// package.json first — if web-push present use it; otherwise
// payload-less push (VAPID ES256 JWT via node crypto; empty POST to
// endpoint wakes the service worker, which fetches
// /api/notifications/latest-unread and shows it)."
//
// FINDING (this round's own study, see final report): package.json has
// NO web-push dependency (grepped — not in dependencies or
// devDependencies), so this file implements the payload-less path,
// entirely on node:crypto (a Node builtin, not a new dependency).
//
// VAPID (RFC 8292) needs an ES256-signed JWT whose `aud` is the push
// endpoint's origin, `exp` <=24h out, `sub` a contact mailto:. The
// Authorization header on the push POST is
// `vapid t=<jwt>, k=<raw-uncompressed-public-key-base64url>` — no
// Crypto-Key header, no body, no payload encryption, because this is a
// payload-less "wake up and go fetch the real content" push, never an
// encrypted-payload one (that would need aes128gcm/ece encryption,
// real work web-push exists specifically to do — deliberately not
// needed here per the spec's own steer).
// ============================================================

const VAPID_SUBJECT = "mailto:phillip@reslu.com.au";
// RFC 8292 caps exp at 24h out from signing; 12h leaves comfortable
// margin without needing per-push freshness precision (this JWT is
// minted fresh on every single push send below, never cached/reused
// across sends, so "12h" only bounds how far in the future THIS one
// token claims to expire, not how long between sends).
const VAPID_JWT_TTL_SECONDS = 12 * 60 * 60;

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/**
 * Builds a fresh ES256 VAPID JWT for one push endpoint's origin.
 *
 * Key material: NEXT_PUBLIC_VAPID_PUBLIC_KEY is the standard
 * uncompressed P-256 point (0x04 || X(32) || Y(32) == 65 bytes,
 * base64url) that also gets handed to the browser's
 * pushManager.subscribe({ applicationServerKey }) — see
 * components/settings/PushSettings.tsx. VAPID_PRIVATE_KEY is just the
 * raw 32-byte scalar `d`, base64url. Combined, the three (d, x, y) are
 * exactly what a JWK EC private key needs — this is the same key pair
 * `npx web-push generate-vapid-keys` would produce, just consumed here
 * via node:crypto's own JWK import instead of the web-push package.
 */
function buildVapidJwt(privateKeyB64Url: string, publicKeyB64Url: string, audience: string): string {
  const publicKeyBytes = Buffer.from(publicKeyB64Url, "base64url");
  if (publicKeyBytes.length !== 65 || publicKeyBytes[0] !== 0x04) {
    throw new Error(
      "NEXT_PUBLIC_VAPID_PUBLIC_KEY must be the raw uncompressed P-256 point (65 bytes, 0x04 prefix), base64url-encoded — see docs/MINI-HEALTH-HANDOFF.md's keygen one-liner."
    );
  }
  const x = publicKeyBytes.subarray(1, 33);
  const y = publicKeyBytes.subarray(33, 65);
  const d = Buffer.from(privateKeyB64Url, "base64url");
  if (d.length !== 32) {
    throw new Error("VAPID_PRIVATE_KEY must be the raw 32-byte P-256 scalar, base64url-encoded.");
  }

  const keyObject = createPrivateKey({
    key: { kty: "EC", crv: "P-256", d: base64url(d), x: base64url(x), y: base64url(y) },
    format: "jwk",
  });

  const header = { typ: "JWT", alg: "ES256" };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const payload = {
    aud: audience,
    exp: nowSeconds + VAPID_JWT_TTL_SECONDS,
    sub: VAPID_SUBJECT,
  };
  const signingInput = `${base64url(Buffer.from(JSON.stringify(header)))}.${base64url(Buffer.from(JSON.stringify(payload)))}`;

  // dsaEncoding: 'ieee-p1363' — raw r||s (64 bytes for P-256), the
  // exact signature format a JWS ES256 signature requires. Node's
  // default ECDSA sign() output is DER-encoded, which is NOT valid
  // here — this option is what makes plain node:crypto usable for JWT
  // signing without a jose/jsonwebtoken dependency.
  const signature = sign("sha256", Buffer.from(signingInput), {
    key: keyObject,
    dsaEncoding: "ieee-p1363",
  });

  return `${signingInput}.${base64url(signature)}`;
}

interface PushSubscriptionLike {
  id: string;
  endpoint: string;
}

/**
 * Sends one payload-less push to one subscription. TTL:60/Urgency:high
 * per BUILD-SPEC.md item 2's exact header list; empty body (no
 * Content-Type/Crypto-Key needed — there is no payload to encrypt).
 * 404/410 means the push service has permanently discarded this
 * subscription (user uninstalled/revoked/browser data cleared) — the
 * row is deleted so it stops being tried forever. Any other non-2xx is
 * reported (lib/report-error.ts) but the row is left alone (could be
 * transient).
 */
async function sendToOneSubscription(
  supabase: ReturnType<typeof createServiceRoleClient>,
  sub: PushSubscriptionLike,
  privateKey: string,
  publicKey: string
): Promise<void> {
  try {
    const origin = new URL(sub.endpoint).origin;
    const jwt = buildVapidJwt(privateKey, publicKey, origin);

    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "60",
        Urgency: "high",
        Authorization: `vapid t=${jwt}, k=${publicKey}`,
        "Content-Length": "0",
      },
    });

    if (res.status === 404 || res.status === 410) {
      await supabase.from("push_subscriptions").delete().eq("id", sub.id);
      return;
    }
    if (!res.ok) {
      await reportError("push-send-non-2xx", new Error(`Push endpoint responded ${res.status} for subscription ${sub.id}`));
    }
  } catch (err) {
    await reportError("push-send-exception", err);
  }
}

/**
 * BUILD-SPEC.md item 2: "lib/push.ts exports sendPushToAdmins(kind,
 * title, body, link) used by all trigger points." Fans a payload-less
 * wake-up push out to every ADMIN's stored subscription (see
 * push_subscriptions' own doc comment — a non-admin can subscribe via
 * the Settings toggle, but is never targeted by this function; nothing
 * in this round creates a per-user, non-admin notification for it to
 * receive anyway).
 *
 * NEVER throws — every call site in this round (the r20 respond route,
 * r23 accept route, health incident routes) treats this exactly like
 * lib/report-error.ts's reportError: best-effort, fire-and-forget,
 * failure here must never turn an otherwise-successful request into an
 * error response. If VAPID env vars are unset, this is a silent no-op
 * (push simply isn't configured yet) — same "no-op until configured"
 * posture as lib/resend.ts's RESEND_API_KEY handling.
 *
 * kind/title/body/link are NOT sent over the wire (the push itself is
 * payload-less — see this file's header comment) — they exist purely
 * so call sites pass the SAME four values they just wrote into the
 * notifications row (the actual content the service worker fetches),
 * keeping the "insert notifications row, then call sendPushToAdmins
 * with the identical fields" call-site shape self-documenting. `kind`
 * doubles as the reportError call-site tag on failure, so a flood of
 * failed sends for one kind (e.g. every subscription gone stale at
 * once) is visible in Settings -> System health without individually
 * flooding it per-subscription.
 */
export async function sendPushToAdmins(
  kind: string,
  title: string,
  body: string,
  link: string | null
): Promise<void> {
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!privateKey || !publicKey) return;

  try {
    const supabase = createServiceRoleClient();

    const { data: admins } = await supabase.from("profiles").select("id").eq("role", "admin");
    const adminIds = (admins ?? []).map((a) => a.id as string);
    if (adminIds.length === 0) return;

    const { data: subs } = await supabase
      .from("push_subscriptions")
      .select("id,endpoint")
      .in("user_id", adminIds);
    if (!subs || subs.length === 0) return;

    for (const sub of subs) {
      await sendToOneSubscription(supabase, sub as PushSubscriptionLike, privateKey, publicKey);
    }
  } catch (err) {
    await reportError(`push-send-to-admins:${kind}`, err);
  }
  // title/body/link are documented above as call-site symmetry only —
  // referenced here so a future encrypted-payload upgrade (a real
  // web-push dependency, should one ever be added) has an obvious
  // single place to start threading them through as an actual payload.
  void title;
  void body;
  void link;
}

/**
 * Item 5's "dedupe: one alert per incident, not per check." Inserts a
 * notifications row (user_id=null, all-admins) + sends the push, but
 * ONLY if there is no existing UNREAD notification of this exact
 * `kind` already open — read_at doubles as the open/closed marker (see
 * migration 053's own notifications table comment). Callers that later
 * observe the underlying condition clear should call
 * resolveOpenIncident(kind) so the NEXT bad transition can fire a
 * fresh alert instead of staying permanently deduped.
 *
 * Used by the silence-checker (GET /api/health/check) and the
 * channel-status route for incident-style conditions that can recur —
 * NOT used by the one-off trade/proposal/diagnostics triggers, which
 * insert their own notifications row directly (each of those is a
 * genuinely new, non-recurring event, not a "still open?" condition).
 */
export async function notifyAdminsOnce(
  kind: string,
  title: string,
  body: string,
  link: string | null
): Promise<{ deduped: boolean }> {
  const supabase = createServiceRoleClient();

  const { data: existingOpen } = await supabase
    .from("notifications")
    .select("id")
    .eq("kind", kind)
    .is("read_at", null)
    .is("user_id", null)
    .maybeSingle();

  if (existingOpen) {
    return { deduped: true };
  }

  await supabase.from("notifications").insert({
    user_id: null,
    kind,
    title,
    body,
    link_href: link,
  });

  await sendPushToAdmins(kind, title, body, link);

  return { deduped: false };
}

/**
 * Marks every open (unread) notification of `kind` as read — the
 * "incident cleared" half of notifyAdminsOnce's dedupe pair. Called by
 * the same routes that fired the incident once they observe the
 * condition has resolved (heartbeat resumed, channel back to ok).
 * Best-effort, never throws.
 */
export async function resolveOpenIncident(kind: string): Promise<void> {
  try {
    const supabase = createServiceRoleClient();
    await supabase
      .from("notifications")
      .update({ read_at: new Date().toISOString() })
      .eq("kind", kind)
      .is("read_at", null)
      .is("user_id", null);
  } catch (err) {
    await reportError("resolve-open-incident", err);
  }
}
