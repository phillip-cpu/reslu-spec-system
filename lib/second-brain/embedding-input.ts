export const MAX_EMBEDDING_TEXTS = 500;
export const MAX_EMBEDDING_TEXT_LENGTH = 32_000;
export const MAX_EMBEDDING_TOTAL_LENGTH = 1_000_000;

/**
 * Keep the native embedding runtime on its deliberately narrow, text-only
 * boundary. The transitive ONNX package currently carries no-fix advisories in
 * archive and image helpers; callers must never be able to pass those shapes
 * through this wrapper or allocate an unbounded inference request.
 */
export function assertBoundedEmbeddingTexts(texts: unknown): asserts texts is string[] {
  if (!Array.isArray(texts)) {
    throw new TypeError("Embedding input must be an array of text strings.");
  }
  if (texts.length > MAX_EMBEDDING_TEXTS) {
    throw new RangeError(`Embedding input exceeds ${MAX_EMBEDDING_TEXTS} texts.`);
  }

  let totalLength = 0;
  for (const text of texts) {
    if (typeof text !== "string") {
      throw new TypeError("Embedding input must contain text strings only.");
    }
    if (text.length > MAX_EMBEDDING_TEXT_LENGTH) {
      throw new RangeError(`Embedding text exceeds ${MAX_EMBEDDING_TEXT_LENGTH} characters.`);
    }
    totalLength += text.length;
    if (totalLength > MAX_EMBEDDING_TOTAL_LENGTH) {
      throw new RangeError(`Embedding input exceeds ${MAX_EMBEDDING_TOTAL_LENGTH} total characters.`);
    }
  }
}
