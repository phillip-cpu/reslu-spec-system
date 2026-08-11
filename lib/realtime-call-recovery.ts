export const MAX_REALTIME_RECONNECT_ATTEMPTS = 5;

export interface RealtimeReconnectState {
  callActive: boolean;
  realtimeActive: boolean;
  online: boolean;
  visible: boolean;
  backgroundCapable: boolean;
  inFlight: boolean;
  attempts: number;
  microphoneReady: boolean;
  connectionState: RTCPeerConnectionState | null;
  dataChannelState: RTCDataChannelState | null;
}

export function shouldAttemptRealtimeReconnect(state: RealtimeReconnectState) {
  if (
    !state.callActive
    || !state.realtimeActive
    || !state.online
    || (!state.visible && !state.backgroundCapable)
    || state.inFlight
    || state.attempts >= MAX_REALTIME_RECONNECT_ATTEMPTS
  ) return false;
  if (!state.microphoneReady) return true;
  if (state.connectionState === "connected" && state.dataChannelState === "open") return false;
  if (
    (state.connectionState === "new" || state.connectionState === "connecting")
    && (state.dataChannelState === "connecting" || state.dataChannelState === "open")
  ) return false;
  return true;
}

export function realtimeReconnectDelay(attempts: number, immediate = false) {
  if (immediate) return 0;
  return [400, 800, 1600, 3000, 5000][Math.min(Math.max(0, attempts), 4)];
}

export function mediaStreamCanResume(stream: MediaStream | null) {
  return Boolean(
    stream?.active
    && stream.getAudioTracks().some((track) => track.readyState === "live")
  );
}
