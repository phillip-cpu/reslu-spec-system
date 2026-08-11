export type NativeVoiceBridgeEvent =
  | {
      type: "call.start";
      callId: string;
      conversationId: string;
      agent: string;
    }
  | { type: "call.connected" }
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

/**
 * Posts lifecycle only to the optional RESLU iOS shell. Safari and the PWA do
 * not expose this handler, so the existing web call remains unchanged.
 */
export function postNativeVoiceBridgeEvent(event: NativeVoiceBridgeEvent) {
  if (typeof window === "undefined") return;
  try {
    (window as NativeVoiceWindow).webkit?.messageHandlers?.resluVoice?.postMessage(event);
  } catch {
    // A native presentation failure must never break or end the canonical call.
  }
}
