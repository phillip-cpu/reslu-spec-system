export const CONVERSATION_UPLOAD_PROBE_DELAY_MS = 10_000;
export const CONVERSATION_UPLOAD_PROBE_INTERVAL_MS = 3_000;
export const CONVERSATION_UPLOAD_MAX_PROBES = 30;

type UploadResult = { error: { message?: string } | null };

export type ConversationUploadProbe<T> =
  | { status: "ready"; value: T }
  | { status: "pending" }
  | { status: "failed"; error: Error; recoverable: boolean };

export class ConversationUploadCompletionError extends Error {
  readonly recoverable: boolean;

  constructor(message: string, recoverable: boolean) {
    super(message);
    this.name = "ConversationUploadCompletionError";
    this.recoverable = recoverable;
  }
}

export function isRecoverableConversationUploadError(reason: unknown) {
  return reason instanceof ConversationUploadCompletionError && reason.recoverable;
}

function errorMessage(reason: unknown, fallback: string) {
  if (reason instanceof Error && reason.message) return reason.message;
  return fallback;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => {
  setTimeout(resolve, milliseconds);
});

/**
 * A signed Storage upload can put every byte in Supabase while iOS Safari
 * waits forever for the upload response. Probe the authenticated finalisation
 * route independently so a complete object becomes usable without a reload
 * or a second transfer.
 */
export async function awaitConversationUploadReady<T>({
  upload,
  probe,
  initialProbeDelayMs = CONVERSATION_UPLOAD_PROBE_DELAY_MS,
  probeIntervalMs = CONVERSATION_UPLOAD_PROBE_INTERVAL_MS,
  maxProbes = CONVERSATION_UPLOAD_MAX_PROBES,
  delay = wait,
}: {
  upload: Promise<UploadResult>;
  probe: () => Promise<ConversationUploadProbe<T>>;
  initialProbeDelayMs?: number;
  probeIntervalMs?: number;
  maxProbes?: number;
  delay?: (milliseconds: number) => Promise<void>;
}): Promise<T> {
  const uploadProgress: {
    state: "pending" | "succeeded" | "failed";
    failure: Error | null;
  } = { state: "pending", failure: null };

  const uploadSettled = upload.then(
    (result) => {
      if (result.error) {
        uploadProgress.state = "failed";
        uploadProgress.failure = new Error(result.error.message || "Could not upload attachment");
      } else {
        uploadProgress.state = "succeeded";
      }
    },
    (reason) => {
      uploadProgress.state = "failed";
      uploadProgress.failure = new Error(errorMessage(reason, "Could not upload attachment"));
    }
  );

  await Promise.race([uploadSettled, delay(Math.max(0, initialProbeDelayMs))]);

  let failedUploadProbes = 0;
  let lastProbeError: Error | null = null;
  for (let attempt = 0; attempt < Math.max(1, maxProbes); attempt += 1) {
    try {
      const result = await probe();
      if (result.status === "ready") return result.value;
      if (result.status === "failed") {
        // A direct multipart upload can fail before its staged row exists.
        // The follow-up probe then returns "Attachment not found", which is
        // only a consequence of the original failure and must not replace its
        // useful server error. A fresh Retry can safely upload the retained
        // local File with a new id.
        if (uploadProgress.state === "failed" && uploadProgress.failure) {
          throw new ConversationUploadCompletionError(uploadProgress.failure.message, false);
        }
        throw new ConversationUploadCompletionError(result.error.message, result.recoverable);
      }
    } catch (reason) {
      if (reason instanceof ConversationUploadCompletionError) throw reason;
      lastProbeError = new Error(errorMessage(reason, "Could not confirm attachment upload"));
    }

    if (uploadProgress.state === "failed") {
      failedUploadProbes += 1;
      if (failedUploadProbes >= 3) {
        throw new ConversationUploadCompletionError(
          uploadProgress.failure?.message ?? "Could not upload attachment",
          true
        );
      }
    }

    if (attempt + 1 < maxProbes) await delay(Math.max(0, probeIntervalMs));
  }

  throw new ConversationUploadCompletionError(
    lastProbeError?.message
      ?? "Upload confirmation is taking longer than expected. Tap Retry to reuse any bytes already received.",
    true
  );
}
