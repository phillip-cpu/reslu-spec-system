export type NativeVoiceBridgeEvent =
  | {
      type: "call.start";
      callId: string;
      clientCallId: string;
      conversationId: string;
      agent: string;
      agentSlug: string;
      transport?: "native-realtime";
    }
  | { type: "call.connected" }
  | { type: "call.muted"; muted: boolean }
  | { type: "call.audio-route"; route: "speaker" | "automatic" }
  | { type: "call.end" }
  | { type: "web.ready" }
  | { type: "realtime.event"; event: Record<string, unknown> };

interface NativeMessageHandler {
  postMessage(message: NativeVoiceBridgeEvent): void;
}

type NativeVoiceWindow = Window & {
  __RESLU_NATIVE_VOICE_CAPABILITIES__?: {
    version?: number;
    nativeRealtimeTransport?: boolean;
  };
  webkit?: {
    messageHandlers?: {
      resluVoice?: NativeMessageHandler;
    };
  };
};

type NativeVoiceEventDetail = {
  type?: "native-audio-ready" | "native-audio-error" | "native-realtime-connected" | "native-realtime-event" | "native-realtime-error" | "end-requested" | "mute-requested" | "mute-sync-error" | "audio-route-changed" | "audio-route-error";
  message?: string;
  muted?: boolean;
  route?: "speaker" | "automatic";
  event?: Record<string, unknown>;
};

export const NATIVE_AUDIO_ACTIVATION_TIMEOUT_MS = 5000;

function nativeVoiceHandler() {
  if (typeof window === "undefined") return null;
  return (window as NativeVoiceWindow).webkit?.messageHandlers?.resluVoice ?? null;
}

export function nativeVoiceBridgeAvailable() {
  return nativeVoiceHandler() != null;
}

export function nativeRealtimeTransportAvailable() {
  if (!nativeVoiceBridgeAvailable() || typeof window === "undefined") return false;
  const capabilities = (window as NativeVoiceWindow).__RESLU_NATIVE_VOICE_CAPABILITIES__;
  return capabilities?.version === 2 && capabilities.nativeRealtimeTransport === true;
}

/**
 * Posts lifecycle or native Realtime events to the optional RESLU iOS shell.
 * Safari and the PWA do not expose this handler, so the web call is unchanged.
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

/** Starts the lock-safe native WebRTC transport and waits for its data channel. */
export function prepareNativeRealtimeSession(
  event: Extract<NativeVoiceBridgeEvent, { type: "call.start" }>,
  timeoutMs = 12_000
) {
  if (!nativeRealtimeTransportAvailable() || typeof window === "undefined") {
    return Promise.reject(new Error("The native iPhone voice transport is unavailable."));
  }
  const handler = nativeVoiceHandler();
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
      if (detail?.type === "native-realtime-connected") finish();
      else if (detail?.type === "native-realtime-error" || detail?.type === "native-audio-error") {
        finish(new Error(detail.message || "The iPhone realtime call could not start."));
      } else if (detail?.type === "end-requested") {
        finish(new Error("The iPhone call ended before realtime audio started."));
      }
    };
    const timer = window.setTimeout(
      () => finish(new Error("The iPhone realtime call did not connect in time.")),
      Math.max(1, timeoutMs)
    );
    window.addEventListener("reslu-native-voice", handleNativeEvent);
    try {
      handler?.postMessage({ ...event, transport: "native-realtime" });
    } catch {
      finish(new Error("The iPhone realtime call could not start."));
    }
  });
}
