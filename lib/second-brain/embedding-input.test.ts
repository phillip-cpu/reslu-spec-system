import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertBoundedEmbeddingTexts,
  MAX_EMBEDDING_TEXT_LENGTH,
  MAX_EMBEDDING_TEXTS,
  MAX_EMBEDDING_TOTAL_LENGTH,
} from "./embedding-input.ts";

const embeddingRuntime = readFileSync(new URL("./embeddings.ts", import.meta.url), "utf8");

test("embedding input accepts the bounded text-only production shape", () => {
  assert.doesNotThrow(() => assertBoundedEmbeddingTexts([]));
  assert.doesNotThrow(() => assertBoundedEmbeddingTexts(["project context", "lead context"]));
  assert.doesNotThrow(() => assertBoundedEmbeddingTexts(Array(MAX_EMBEDDING_TEXTS).fill("bounded")));
});

test("embedding input rejects non-text native helper inputs", () => {
  assert.throws(() => assertBoundedEmbeddingTexts("text"), /array of text strings/);
  assert.throws(() => assertBoundedEmbeddingTexts([Buffer.from("archive bytes")]), /text strings only/);
  assert.throws(() => assertBoundedEmbeddingTexts([{ image: "untrusted" }]), /text strings only/);
});

test("embedding input rejects excessive item, text and aggregate sizes", () => {
  assert.throws(() => assertBoundedEmbeddingTexts(Array(MAX_EMBEDDING_TEXTS + 1).fill("x")), /exceeds 500 texts/);
  assert.throws(() => assertBoundedEmbeddingTexts(["x".repeat(MAX_EMBEDDING_TEXT_LENGTH + 1)]), /exceeds 32000 characters/);
  const aggregate = Array(Math.ceil(MAX_EMBEDDING_TOTAL_LENGTH / MAX_EMBEDDING_TEXT_LENGTH)).fill("x".repeat(MAX_EMBEDDING_TEXT_LENGTH));
  assert.throws(() => assertBoundedEmbeddingTexts(aggregate), /exceeds 1000000 total characters/);
});

test("native embedding runtime stays pinned to the fixed text feature-extraction model", () => {
  assert.match(embeddingRuntime, /const MODEL = "Supabase\/gte-small"/);
  assert.match(embeddingRuntime, /const MODEL_REVISION = "93b36ff09519291b77d6000d2e86bd8565378086"/);
  assert.match(embeddingRuntime, /pipeline\("feature-extraction", MODEL/);
  assert.match(embeddingRuntime, /revision: MODEL_REVISION/);
  assert.match(embeddingRuntime, /assertBoundedEmbeddingTexts\(texts\)/);
  assert.doesNotMatch(embeddingRuntime, /pipeline\("(?:image|object|audio|document|background)/);
});
