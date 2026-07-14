import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { verifyResendWebhookSignature } from "./resend-webhook.ts";

const eventId = "msg_test";
const timestamp = "1783990000";
const body = JSON.stringify({ type: "email.delivered", data: { email_id: "email_123" } });
const secretBytes = Buffer.from("reslu-test-secret", "utf8");
const secret = `whsec_${secretBytes.toString("base64")}`;
const signature = createHmac("sha256", secretBytes)
  .update(`${eventId}.${timestamp}.${body}`, "utf8")
  .digest("base64");

test("accepts a valid current Svix signature", () => {
  assert.equal(
    verifyResendWebhookSignature({
      body,
      eventId,
      timestamp,
      signatureHeader: `v1,${signature}`,
      secret,
      nowSeconds: Number(timestamp),
    }),
    true
  );
});

test("rejects a changed body and stale timestamp", () => {
  assert.equal(
    verifyResendWebhookSignature({
      body: `${body} `,
      eventId,
      timestamp,
      signatureHeader: `v1,${signature}`,
      secret,
      nowSeconds: Number(timestamp),
    }),
    false
  );
  assert.equal(
    verifyResendWebhookSignature({
      body,
      eventId,
      timestamp,
      signatureHeader: `v1,${signature}`,
      secret,
      nowSeconds: Number(timestamp) + 301,
    }),
    false
  );
});
