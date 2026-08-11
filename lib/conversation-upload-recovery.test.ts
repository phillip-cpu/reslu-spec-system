import assert from "node:assert/strict";
import test from "node:test";
import {
  awaitConversationUploadReady,
  ConversationUploadCompletionError,
  isRecoverableConversationUploadError,
} from "./conversation-upload-recovery.ts";

const noWait = async () => undefined;

test("a completed upload finalises normally", async () => {
  const attachment = { id: "ready" };
  const result = await awaitConversationUploadReady({
    upload: Promise.resolve({ error: null }),
    probe: async () => ({ status: "ready", value: attachment }),
    delay: noWait,
  });
  assert.equal(result, attachment);
});

test("a hung iPhone upload response is bypassed once Storage is verifiably complete", async () => {
  const neverSettles = new Promise<{ error: null }>(() => undefined);
  let probes = 0;
  const result = await awaitConversationUploadReady({
    upload: neverSettles,
    probe: async () => {
      probes += 1;
      return probes === 1
        ? { status: "pending" }
        : { status: "ready", value: "recovered" };
    },
    initialProbeDelayMs: 0,
    probeIntervalMs: 0,
    maxProbes: 2,
    delay: noWait,
  });
  assert.equal(result, "recovered");
  assert.equal(probes, 2);
});

test("a rejected upload still gets a bounded chance to recover completed bytes", async () => {
  let probes = 0;
  const result = await awaitConversationUploadReady({
    upload: Promise.reject(new Error("lost upload response")),
    probe: async () => {
      probes += 1;
      return probes === 2
        ? { status: "ready", value: "already stored" }
        : { status: "pending" };
    },
    probeIntervalMs: 0,
    delay: noWait,
  });
  assert.equal(result, "already stored");
});

test("a persistently failed upload stays recoverable instead of deleting possible bytes", async () => {
  await assert.rejects(
    awaitConversationUploadReady({
      upload: Promise.resolve({ error: { message: "connection lost" } }),
      probe: async () => ({ status: "pending" }),
      probeIntervalMs: 0,
      delay: noWait,
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof ConversationUploadCompletionError);
      assert.equal(reason.message, "connection lost");
      assert.equal(isRecoverableConversationUploadError(reason), true);
      return true;
    }
  );
});

test("a permanent finalisation error does not offer a misleading retry", async () => {
  await assert.rejects(
    awaitConversationUploadReady({
      upload: Promise.resolve({ error: null }),
      probe: async () => ({
        status: "failed",
        error: new Error("The file contents do not match its file type."),
        recoverable: false,
      }),
      delay: noWait,
    }),
    (reason: unknown) => {
      assert.ok(reason instanceof ConversationUploadCompletionError);
      assert.equal(isRecoverableConversationUploadError(reason), false);
      return true;
    }
  );
});
