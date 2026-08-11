import assert from "node:assert/strict";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { decryptXeroSecret, encryptXeroSecret } from "./crypto.ts";

test("Xero tokens round-trip through authenticated encryption", () => {
  const key = randomBytes(32).toString("base64");
  const encrypted = encryptXeroSecret("refresh-token-value", key);
  assert.notEqual(encrypted, "refresh-token-value");
  assert.equal(decryptXeroSecret(encrypted, key), "refresh-token-value");
});

test("Xero token ciphertext cannot be opened with a different key", () => {
  const encrypted = encryptXeroSecret("secret", randomBytes(32).toString("base64"));
  assert.throws(() => decryptXeroSecret(encrypted, randomBytes(32).toString("base64")));
});
