import assert from "node:assert/strict";
import test from "node:test";
import { boundedFetch, BoundedRequestTimeoutError } from "./bounded-request.ts";

test("a stalled request is aborted at its bounded deadline", async () => {
  const originalFetch = globalThis.fetch;
  let observedAbort = false;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal ?? null;
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => {
        observedAbort = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => boundedFetch("https://example.test/stalled", {}, 5),
      BoundedRequestTimeoutError,
    );
    assert.equal(observedAbort, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a completed request returns normally before the deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("ok", { status: 200 })) as typeof fetch;

  try {
    const response = await boundedFetch("https://example.test/ready", {}, 100);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "ok");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an existing caller signal still cancels the bounded request", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  })) as typeof fetch;
  const caller = new AbortController();

  try {
    const pending = boundedFetch("https://example.test/cancelled", { signal: caller.signal }, 1_000);
    caller.abort();
    await assert.rejects(() => pending, { name: "AbortError" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
