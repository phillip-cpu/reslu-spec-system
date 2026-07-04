/**
 * Gmail send helper for the team digest on client portal actions
 * (BUILD-SPEC.md §9 / Review §1.8: "email digest to team on client
 * portal actions").
 *
 * Uses the OAuth refresh-token flow against the aria@reslu.com.au
 * mailbox. All credentials come from env and MUST be rotated values —
 * the ones in the original brief are considered compromised. When any
 * credential is missing, send() is a no-op returning { skipped: true },
 * so the portal keeps working before the integration is wired up.
 */

const SENDER = "RESLU <aria@reslu.com.au>";

interface SendResult {
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
      `Subject: ${subject}`,
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
