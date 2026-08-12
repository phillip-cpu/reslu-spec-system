import assert from "node:assert/strict";
import test from "node:test";
import { inspectStorageObjectHead, sniffFileKind } from "./file-sniff.ts";

function fakeStorageClient() {
  return {
    storage: {
      from: () => ({
        createSignedUrl: async () => ({ data: { signedUrl: "https://storage.example/private" }, error: null }),
      }),
    },
  } as never;
}

test("storage inspection reads only a 16-byte prefix when Range is ignored", async (context) => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(1024).fill(7));
    },
    cancel() { cancelled = true; },
  }), {
    status: 200,
    headers: { "Content-Length": "104857600" },
  });

  const inspection = await inspectStorageObjectHead(fakeStorageClient(), "assets", "private/file");
  assert.equal(inspection?.bytes.length, 16);
  assert.equal(inspection?.byteSize, 104_857_600);
  assert.equal(cancelled, true);
});

test("storage inspection derives the real object size from a range response", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response(Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]), {
    status: 206,
    headers: { "Content-Range": "bytes 0-15/1786192" },
  });

  const inspection = await inspectStorageObjectHead(fakeStorageClient(), "assets", "private/file");
  assert.equal(inspection?.bytes.length, 16);
  assert.equal(inspection?.byteSize, 1_786_192);
});

test("voice-note containers are identified from their actual leading bytes", () => {
  assert.equal(sniffFileKind(Uint8Array.from([
    0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x4d, 0x34, 0x41, 0x20,
  ])), "mp4");
  assert.equal(sniffFileKind(Uint8Array.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81,
  ])), "webm");
  assert.equal(sniffFileKind(Uint8Array.from([
    0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0,
  ])), "unknown");
});
