/**
 * Gmail send helper — low-level transport only.
 *
 * Uses the OAuth refresh-token flow against the aria@reslu.com.au
 * mailbox. All credentials come from env and MUST be rotated values —
 * the ones in the original brief PDF are considered compromised. When
 * any credential is missing, send() is a no-op returning
 * { skipped: true }, so callers stay dormant until the integration is
 * wired up.
 *
 * Moved from lib/gmail.ts (Week 4 restructure into lib/gmail/**) —
 * logic unchanged, this is still the same OAuth refresh-token flow.
 * lib/gmail/digest.ts is the higher-level module that decides *when*
 * and *what* to send (the portal-action digest).
 */

const SENDER = "RESLU <aria@reslu.com.au>";

export interface SendResult {
  skipped: boolean;
  reason?: string;
}

function creds() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const refreshToken = process.env.ARIA_GMAIL_REFRESH_TOKEN;
  const tokenUri =
    process.env.GMAIL_TOKEN_URI ?? "https://oauth2.googleapis.com/token";
  if (!clientId || !clientSecret || !refreshToken) return null;
  return { clientId, clientSecret, refreshToken, tokenUri };
}

export function isGmailConfigured(): boolean {
  return creds() !== null;
}

async function getAccessToken(c: NonNullable<ReturnType<typeof creds>>) {
  const res = await fetch(c.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      refresh_token: c.refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Token exchange failed (${res.status})`);
  const json = await res.json();
  return json.access_token as string;
}

function toBase64Url(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Sends a plain-text email from the shared RESLU/Aria mailbox. Never
 * throws for the "not configured" case — returns { skipped: true }
 * instead so callers (digest flush, etc.) can no-op cleanly. Real send
 * failures (bad token, Gmail API error) DO throw, since those callers
 * are expected to catch and log rather than silently swallow — a
 * digest flush needs to know a send failed so it doesn't mark the
 * queue rows as sent.
 */
export async function sendTeamEmail({
  to,
  subject,
  body,
}: {
  to: string[];
  subject: string;
  body: string;
}): Promise<SendResult> {
  const c = creds();
  if (!c) return { skipped: true, reason: "Gmail credentials not configured" };
  if (to.length === 0) return { skipped: true, reason: "No recipients" };

  const accessToken = await getAccessToken(c);

  const raw = toBase64Url(
    [
      `From: ${SENDER}`,
      `To: ${to.join(", ")}`,
      // RFC 2047 encoded-word: subjects with em-dashes/accents arrive
      // garbled ("â€”") in some clients if sent raw. Always base64-encode.
      `Subject: =?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`,
      "MIME-Version: 1.0",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      body,
    ].join("\r\n")
  );

  const res = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ raw }),
      signal: AbortSignal.timeout(10_000),
    }
  );
  if (!res.ok) throw new Error(`Gmail send failed (${res.status})`);
  return { skipped: false };
}
