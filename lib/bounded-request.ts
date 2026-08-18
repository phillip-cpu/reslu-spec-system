export const DEFAULT_BOUNDED_REQUEST_TIMEOUT_MS = 8_000;

export class BoundedRequestTimeoutError extends Error {
  constructor() {
    super("The connection took too long. RESLU will try again automatically.");
    this.name = "BoundedRequestTimeoutError";
  }
}

const RESPONSE_BODY_READERS = new Set<PropertyKey>([
  "arrayBuffer",
  "blob",
  "bytes",
  "formData",
  "json",
  "text",
]);

export async function boundedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_BOUNDED_REQUEST_TIMEOUT_MS,
) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("The request timeout must be a positive number");
  }

  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromCaller = () => controller.abort();

  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener("abort", abortFromCaller, { once: true });

  let timedOut = false;
  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  };
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    cleanup();
  }, timeoutMs);
  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    if (response.body === null) {
      cleanup();
      return response;
    }
    return new Proxy(response, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (!RESPONSE_BODY_READERS.has(property)) return value.bind(target);
        return async (...args: unknown[]) => {
          try {
            return await value.apply(target, args);
          } catch (reason) {
            if (timedOut) throw new BoundedRequestTimeoutError();
            throw reason;
          } finally {
            cleanup();
          }
        };
      },
    });
  } catch (reason) {
    cleanup();
    if (timedOut) throw new BoundedRequestTimeoutError();
    throw reason;
  }
}
