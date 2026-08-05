import assert from "node:assert/strict";
import test from "node:test";
import { friendlyFailureNote } from "./failure-note.ts";

test("explains that an upstream 403 requires manual entry", () => {
  assert.equal(
    friendlyFailureNote("Upstream returned 403"),
    "The supplier blocked automatic server access (403) — open the product page and enter the price/details manually"
  );
});

test("keeps other upstream failures retryable", () => {
  assert.equal(
    friendlyFailureNote("Upstream returned 429"),
    "The supplier page returned error 429 — open it manually or retry later"
  );
});

test("keeps timeout guidance retryable", () => {
  assert.equal(
    friendlyFailureNote("This operation was aborted after a timeout"),
    "The supplier page took too long to respond — retry or open it manually"
  );
});
