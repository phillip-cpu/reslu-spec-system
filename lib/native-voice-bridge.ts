export type NativeVoiceBridgeEvent =
  | {
      type: "call.start";
      callId: string;
      conversationId: string;
      agent: string;
    }
  | { type: "call.connected" }
  | { type: "call.muted"; muted: boolean }
  | { type: "call.end" };

interface NativeMessageHandler {
  postMessage(message: NativeVoiceBridgeEvent): void;
}

type NativeVoiceWindow = Window & {
  webkit?: {
    messageHandlers?: {
      resluVoice?: NativeMessageHandler;
    };
  };
};

type NativeVoiceEventDetail = {
  type?: "native-audio-ready" | "native-audio-error" | "end-requested" | "mute-requested" | "mute-sync-error";
  message?: string;
  muted?: boolean;
};

export const NATIVE_AUDIO_ACTIVATION_TIMEOUT_MS = 5000;

function nativeVoiceHandler() {
  if (typeof window === "undefined") return null;
  return (window as NativeVoiceWindow).webkit?.messageHandlers?.resluVoice ?? null;
}

export function nativeVoiceBridgeAvailable() {
  return nativeVoiceHandler() != null;
}

/**
 * Posts lifecycle only to the optional RESLU iOS shell. Safari and the PWA do
 * not expose this handler, so the existing web call remains unchanged.
 */
export function postNativeVoiceBridgeEvent(event: NativeVoiceBridgeEvent) {
  try {
    nativeVoiceHandler()?.postMessage(event);
  } catch {
    // A native presentation failure must never break or end the canonical call.
  }
}

/** Wait for CallKit to activate the iOS audio session before WebRTC capture. */
export function prepareNativeVoiceSession(
  event: Extract<NativeVoiceBridgeEvent, { type: "call.start" }>,
  timeoutMs = NATIVE_AUDIO_ACTIVATION_TIMEOUT_MS
) {
  const handler = nativeVoiceHandler();
  if (!handler || typeof window === "undefined") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("reslu-native-voice", handleNativeEvent);
      if (error) reject(error);
      else resolve();
    };
    const handleNativeEvent = (received: Event) => {
      const detail = (received as CustomEvent<NativeVoiceEventDetail>).detail;
      if (detail?.type === "native-audio-ready") finish();
      else if (detail?.type === "native-audio-error") {
        finish(new Error(detail.message || "The iPhone audio session could not start."));
      } else if (detail?.type === "end-requested") {
        finish(new Error("The iPhone call ended before audio started."));
      }
    };
    const timer = window.setTimeout(
      () => finish(new Error("The iPhone audio session did not activate in time.")),
      Math.max(1, timeoutMs)
    );
    window.addEventListener("reslu-native-voice", handleNativeEvent);
    try {
      handler.postMessage(event);
    } catch {
      finish(new Error("The iPhone call interface could not start."));
    }
  });
}
