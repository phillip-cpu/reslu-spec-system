import { BoundedRequestTimeoutError } from "./bounded-request.ts";

export function isTransientConversationNetworkError(reason: unknown) {
  return reason instanceof BoundedRequestTimeoutError || reason instanceof TypeError;
}

/** Retry an idempotent operation without changing its caller-owned intent id. */
export async function retrySameConversationIntent<T>(
  operation: () => Promise<T>,
  maxAttempts = 2,
): Promise<T> {
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("Conversation network attempts must be between 1 and 3.");
  }
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (reason) {
      lastError = reason;
      if (!isTransientConversationNetworkError(reason) || attempt + 1 >= maxAttempts) throw reason;
    }
  }
  throw lastError;
}
