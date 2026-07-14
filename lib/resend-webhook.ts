import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TOLERANCE_SECONDS = 5 * 60;

function secretBytes(secret: string): Buffer {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  return Buffer.from(encoded, "base64");
}

/**
 * Verify the Svix signature used by Resend webhooks against the exact
 * raw request body. Multiple v1 signatures are supported for signing-
 * secret rotation. The timestamp window blocks replayed requests.
 */
export function verifyResendWebhookSignature({
  body,
  eventId,
  timestamp,
  signatureHeader,
  secret,
  nowSeconds = Math.floor(Date.now() / 1000),
  toleranceSeconds = DEFAULT_TOLERANCE_SECONDS,
}: {
  body: string;
  eventId: string;
  timestamp: string;
  signatureHeader: string;
  secret: string;
  nowSeconds?: number;
  toleranceSeconds?: number;
}): boolean {
  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) return false;
  if (Math.abs(nowSeconds - timestampSeconds) > toleranceSeconds) return false;

  let expected: Buffer;
  try {
    expected = createHmac("sha256", secretBytes(secret))
      .update(`${eventId}.${timestamp}.${body}`, "utf8")
      .digest();
  } catch {
    return false;
  }

  const signatures = signatureHeader
    .split(/\s+/)
    .map((value) => value.trim())
    .filter(Boolean);

  return signatures.some((entry) => {
    const comma = entry.indexOf(",");
    if (comma === -1 || entry.slice(0, comma) !== "v1") return false;
    try {
      const candidate = Buffer.from(entry.slice(comma + 1), "base64");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    } catch {
      return false;
    }
  });
}
