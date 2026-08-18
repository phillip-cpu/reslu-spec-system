export const DEFAULT_BOUNDED_REQUEST_TIMEOUT_MS = 8_000;

export class BoundedRequestTimeoutError extends Error {
  constructor() {
    super("The connection took too long. RESLU will try again automatically.");
    this.name = "BoundedRequestTimeoutError";
  }
}

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
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (reason) {
    if (timedOut) throw new BoundedRequestTimeoutError();
    throw reason;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener("abort", abortFromCaller);
  }
}
