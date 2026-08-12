import Foundation

@MainActor
final class NativeVoiceContinuityMetrics {
    private(set) var backgroundTransitions = 0
    private(set) var reconnectAttempts = 0
    private(set) var dataChannelOpens = 0
    private(set) var audioRouteChanges = 0
    private(set) var callKitAudioActivations = 0
    private(set) var muteChanges = 0
    private(set) var endedWhileBackground = false
    private(set) var replayedWebEvents = 0
    private(set) var peakBufferedWebEvents = 0

    func reset() {
        backgroundTransitions = 0
        reconnectAttempts = 0
        dataChannelOpens = 0
        audioRouteChanges = 0
        callKitAudioActivations = 0
        muteChanges = 0
        endedWhileBackground = false
        replayedWebEvents = 0
        peakBufferedWebEvents = 0
    }

    func didEnterBackground() { backgroundTransitions = min(1_000, backgroundTransitions + 1) }
    func didAttemptReconnect() { reconnectAttempts = min(1_000, reconnectAttempts + 1) }
    func didOpenDataChannel() { dataChannelOpens = min(1_000, dataChannelOpens + 1) }
    func didChangeAudioRoute() { audioRouteChanges = min(1_000, audioRouteChanges + 1) }
    func didActivateCallKitAudio() { callKitAudioActivations = min(1_000, callKitAudioActivations + 1) }
    func didChangeMute() { muteChanges = min(1_000, muteChanges + 1) }
    func didEndWhileBackground() { endedWhileBackground = true }
    func didReplayWebEvents(_ count: Int) { replayedWebEvents = min(1_000, replayedWebEvents + max(0, count)) }
    func didBufferWebEvents(_ count: Int) { peakBufferedWebEvents = min(80, max(peakBufferedWebEvents, count)) }

    var payload: [String: Any] {
        [
            "schema_version": 1,
            "transport": "native_webrtc_callkit",
            "background_transitions": backgroundTransitions,
            "reconnect_attempts": reconnectAttempts,
            "data_channel_opens": dataChannelOpens,
            "audio_route_changes": audioRouteChanges,
            "callkit_audio_activations": callKitAudioActivations,
            "mute_changes": muteChanges,
            "ended_while_background": endedWhileBackground,
            "replayed_web_events": replayedWebEvents,
            "peak_buffered_web_events": peakBufferedWebEvents,
        ]
    }
}
