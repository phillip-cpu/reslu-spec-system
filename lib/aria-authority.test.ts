import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalJson,
  deriveActionTarget,
  payloadSha256,
  validatedAuthorityEnvelope,
  verificationFromResult,
} from "./aria-authority.ts";

test("payload hashes are deterministic across object key order", () => {
  assert.equal(canonicalJson({ b: 2, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":2}');
  assert.equal(payloadSha256({ b: 2, a: 1 }), payloadSha256({ a: 1, b: 2 }));
});

test("authority envelopes reject missing or malformed audit identities", () => {
  assert.throws(() => validatedAuthorityEnvelope({ request_id: "r" }), /correlation_id/);
  assert.throws(() => validatedAuthorityEnvelope({ request_id: "r", correlation_id: "c", idempotency_key: "bad key" }), /idempotency_key/);
  assert.equal(validatedAuthorityEnvelope({ request_id: "r-1", correlation_id: "c-1", idempotency_key: "i-1" }).expected_absent, false);
});

test("targets come from typed tool arguments instead of a model label", () => {
  assert.deepEqual(
    deriveActionTarget("move_lead_stage", { lead_id: "lead-123" }, { target_type: "project", target_id: "wrong" }),
    { target_type: "lead", target_id: "lead-123" },
  );
});

test("draft verification refuses a consequential returned state", () => {
  const result = verificationFromResult("post_client_update", "draft_record", { id: "p1", status: "published", updated_at: "v2" });
  assert.equal(result.outcome, "partial");
  assert.equal(result.receipt_ref, null);
});

test("authoritative result identity produces a content-addressed receipt", () => {
  const result = verificationFromResult("update_lead", "spec_readback", { id: "l1", status: "active", updated_at: "v3" });
  assert.equal(result.outcome, "verified");
  assert.equal(result.resulting_version, "v3");
  assert.match(result.receipt_ref ?? "", /^reslu:\/\/spec_readback\/update_lead\/l1$/);
});
