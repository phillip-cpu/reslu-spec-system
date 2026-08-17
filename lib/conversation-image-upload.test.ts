import assert from "node:assert/strict";
import test from "node:test";
import {
  CONVERSATION_IMAGE_MAX_DIMENSION,
  CONVERSATION_IMAGE_OPTIMIZE_THRESHOLD_BYTES,
  conversationImageUploadDimensions,
  prepareConversationImageForUpload,
  shouldOptimizeConversationImage,
} from "./conversation-image-upload.ts";

test("only large supported images are prepared before upload", () => {
  assert.equal(shouldOptimizeConversationImage({ name: "photo.jpg", type: "image/jpeg", size: 5_147_908 }), true);
  assert.equal(shouldOptimizeConversationImage({
    name: "photo.jpg",
    type: "image/jpeg",
    size: CONVERSATION_IMAGE_OPTIMIZE_THRESHOLD_BYTES,
  }), false);
  assert.equal(shouldOptimizeConversationImage({ name: "photo.HEIC", type: "", size: 900_000 }), true);
  assert.equal(shouldOptimizeConversationImage({ name: "brief.pdf", type: "application/pdf", size: 8_000_000 }), false);
});

test("an iPhone HEIC photo is converted to a bounded JPEG before upload", async () => {
  const original = new File([new Uint8Array(2_000_000)], "IMG_7001.HEIC", {
    type: "image/heic",
    lastModified: 456,
  });
  const prepared = await prepareConversationImageForUpload(original, async () => ({
    width: 4032,
    height: 3024,
    encode: async (options) => {
      assert.equal(options.mimeType, "image/jpeg");
      return new Blob([new Uint8Array(850_000)], { type: "image/jpeg" });
    },
  }));

  assert.equal(prepared.name, "IMG_7001.jpg");
  assert.equal(prepared.type, "image/jpeg");
  assert.equal(prepared.lastModified, original.lastModified);
  assert.equal(prepared.size, 850_000);
});

test("large camera dimensions are bounded without cropping", () => {
  assert.deepEqual(conversationImageUploadDimensions(4032, 3024), { width: 2048, height: 1536 });
  assert.deepEqual(conversationImageUploadDimensions(3024, 4032), { width: 1536, height: 2048 });
  assert.deepEqual(conversationImageUploadDimensions(1200, 900), { width: 1200, height: 900 });
  assert.equal(conversationImageUploadDimensions(0, 900), null);
  assert.equal(CONVERSATION_IMAGE_MAX_DIMENSION, 2048);
});

test("a large photo is replaced by the smaller encoded file", async () => {
  const original = new File([new Uint8Array(3_000_000)], "IMG_5165.jpeg", {
    type: "image/jpeg",
    lastModified: 123,
  });
  let disposed = false;
  const prepared = await prepareConversationImageForUpload(original, async () => ({
    width: 4032,
    height: 3024,
    encode: async (options) => {
      assert.deepEqual({ width: options.width, height: options.height }, { width: 2048, height: 1536 });
      return new Blob([new Uint8Array(700_000)], { type: "image/jpeg" });
    },
    dispose: () => { disposed = true; },
  }));

  assert.notEqual(prepared, original);
  assert.equal(prepared.name, original.name);
  assert.equal(prepared.type, original.type);
  assert.equal(prepared.lastModified, original.lastModified);
  assert.equal(prepared.size, 700_000);
  assert.equal(disposed, true);
});

test("an unhelpful or failed conversion safely keeps the original", async () => {
  const original = new File([new Uint8Array(3_000_000)], "photo.jpg", { type: "image/jpeg" });
  const notSmaller = await prepareConversationImageForUpload(original, async () => ({
    width: 2500,
    height: 1800,
    encode: async () => new Blob([new Uint8Array(2_800_000)], { type: "image/jpeg" }),
  }));
  const failed = await prepareConversationImageForUpload(original, async () => {
    throw new Error("decode failed");
  });

  assert.equal(notSmaller, original);
  assert.equal(failed, original);
});
