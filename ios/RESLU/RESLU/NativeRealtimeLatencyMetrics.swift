import Foundation

/// Content-free, bounded timing telemetry for native Realtime calls.
/// Internal provider/tool identifiers are used only to correlate events and are
/// never included in `payload`.
@MainActor
final class NativeRealtimeLatencyMetrics {
    private struct TurnTiming {
        let toolCallId: String
        let turn: Int
        var outcome = "pending"
        var speechStoppedAt: TimeInterval?
        var toolCallAt: TimeInterval
        var progressRequestedAt: TimeInterval?
        var progressAudioAt: TimeInterval?
        var consultStartedAt: TimeInterval?
        var consultAcceptedAt: TimeInterval?
        var answerReadyAt: TimeInterval?
        var responseRequestedAt: TimeInterval?
        var firstAudioAt: TimeInterval?
        var queueWaitMs: Double?
        var agentProcessingMs: Double?
        var backendTotalMs: Double?
        var interruptionToMuteMs: Double?
        var interruptionToBufferClearedMs: Double?
    }

    private struct InterruptionTiming {
        let detectedAt: TimeInterval
        var mutedAt: TimeInterval?
        let toolCallId: String?
    }

    private let maximumTurns = 20
    private let maximumDurationMs = 30 * 60 * 1_000.0
    private var latestSpeechStoppedAt: TimeInterval?
    private var timings = [String: TurnTiming]()
    private var orderedToolCallIds = [String]()
    private var responseToolCallIds = [String: String]()
    private var progressResponseIds = Set<String>()
    private var pendingProgressToolCallId: String?
    private var pendingFinalToolCallId: String?
    private var interruptions = [String: InterruptionTiming]()

    private var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    func reset() {
        latestSpeechStoppedAt = nil
        timings.removeAll(keepingCapacity: true)
        orderedToolCallIds.removeAll(keepingCapacity: true)
        responseToolCallIds.removeAll(keepingCapacity: true)
        progressResponseIds.removeAll(keepingCapacity: true)
        pendingProgressToolCallId = nil
        pendingFinalToolCallId = nil
        interruptions.removeAll(keepingCapacity: true)
    }

    func didStopSpeech() {
        latestSpeechStoppedAt = now
    }

    func didReceiveToolCall(_ toolCallId: String) {
        guard timings[toolCallId] == nil, orderedToolCallIds.count < maximumTurns else { return }
        timings[toolCallId] = TurnTiming(
            toolCallId: toolCallId,
            turn: orderedToolCallIds.count + 1,
            speechStoppedAt: latestSpeechStoppedAt,
            toolCallAt: now
        )
        orderedToolCallIds.append(toolCallId)
        latestSpeechStoppedAt = nil
    }

    func didStartConsult(_ toolCallId: String) {
        update(toolCallId) { $0.consultStartedAt = now }
    }

    func didAcceptConsult(_ toolCallId: String) {
        update(toolCallId) { $0.consultAcceptedAt = now }
    }

    func didCompleteConsult(_ toolCallId: String, latency: [String: Any]?) {
        update(toolCallId) {
            $0.answerReadyAt = now
            $0.queueWaitMs = number(latency?["queue_wait_ms"])
            $0.agentProcessingMs = number(latency?["agent_processing_ms"])
            $0.backendTotalMs = number(latency?["backend_total_ms"])
        }
    }

    func didFail(_ toolCallId: String) {
        update(toolCallId) { $0.outcome = "failed" }
    }

    func didCancel(_ toolCallId: String) {
        update(toolCallId) { $0.outcome = "cancelled" }
    }

    func didRequestProgress(_ toolCallId: String) {
        pendingProgressToolCallId = toolCallId
        update(toolCallId) { $0.progressRequestedAt = now }
    }

    func didRequestFinalResponse(_ toolCallId: String) {
        pendingFinalToolCallId = toolCallId
        update(toolCallId) { $0.responseRequestedAt = now }
    }

    func didCreateResponse(_ responseId: String, isProgress: Bool) {
        let toolCallId = isProgress ? pendingProgressToolCallId : pendingFinalToolCallId
        guard let toolCallId, timings[toolCallId] != nil else { return }
        responseToolCallIds[responseId] = toolCallId
        if isProgress {
            progressResponseIds.insert(responseId)
            pendingProgressToolCallId = nil
        } else {
            pendingFinalToolCallId = nil
        }
    }

    func didStartAudio(responseId: String?) {
        guard let responseId, let toolCallId = responseToolCallIds[responseId] else { return }
        if progressResponseIds.contains(responseId) {
            update(toolCallId) {
                if $0.progressAudioAt == nil { $0.progressAudioAt = now }
            }
        } else {
            update(toolCallId) {
                if $0.firstAudioAt == nil {
                    $0.firstAudioAt = now
                    $0.outcome = "spoken"
                }
            }
        }
    }

    func didDetectInterruption(responseId: String?) {
        guard let responseId else { return }
        interruptions[responseId] = InterruptionTiming(
            detectedAt: now,
            mutedAt: nil,
            toolCallId: responseToolCallIds[responseId]
        )
    }

    func didMuteInterruption(responseId: String?) {
        guard let responseId, var interruption = interruptions[responseId] else { return }
        interruption.mutedAt = now
        interruptions[responseId] = interruption
        guard let toolCallId = interruption.toolCallId else { return }
        update(toolCallId) {
            $0.interruptionToMuteMs = duration(start: interruption.detectedAt, end: interruption.mutedAt)
            if $0.outcome == "pending" { $0.outcome = "cancelled" }
        }
    }

    func didClearAudio(responseId: String?) {
        let responseIds = responseId.map { [$0] } ?? Array(interruptions.keys)
        for responseId in responseIds {
            guard let interruption = interruptions.removeValue(forKey: responseId),
                  let toolCallId = interruption.toolCallId else { continue }
            update(toolCallId) {
                $0.interruptionToBufferClearedMs = duration(start: interruption.detectedAt, end: now)
                if $0.outcome == "pending" { $0.outcome = "cancelled" }
            }
        }
    }

    var payload: [[String: Any]] {
        orderedToolCallIds.prefix(maximumTurns).compactMap { toolCallId in
            guard let timing = timings[toolCallId] else { return nil }
            var metric: [String: Any] = [
                "turn": timing.turn,
                "outcome": timing.outcome,
            ]
            addDuration(&metric, "speech_to_ack_ms", timing.speechStoppedAt, timing.progressAudioAt)
            addDuration(&metric, "ack_request_to_audio_ms", timing.progressRequestedAt, timing.progressAudioAt)
            addDuration(&metric, "speech_to_tool_ms", timing.speechStoppedAt, timing.toolCallAt)
            addDuration(&metric, "consult_accept_ms", timing.consultStartedAt, timing.consultAcceptedAt)
            addDuration(&metric, "consult_round_trip_ms", timing.consultStartedAt, timing.answerReadyAt)
            addNumber(&metric, "queue_wait_ms", timing.queueWaitMs)
            addNumber(&metric, "agent_processing_ms", timing.agentProcessingMs)
            addNumber(&metric, "backend_total_ms", timing.backendTotalMs)
            addDuration(&metric, "response_to_first_audio_ms", timing.responseRequestedAt, timing.firstAudioAt)
            addDuration(&metric, "speech_to_first_audio_ms", timing.speechStoppedAt, timing.firstAudioAt)
            addNumber(&metric, "interruption_to_mute_ms", timing.interruptionToMuteMs)
            addNumber(&metric, "interruption_to_buffer_cleared_ms", timing.interruptionToBufferClearedMs)
            return metric
        }
    }

    private func update(_ toolCallId: String, _ mutation: (inout TurnTiming) -> Void) {
        guard var timing = timings[toolCallId] else { return }
        mutation(&timing)
        timings[toolCallId] = timing
    }

    private func number(_ value: Any?) -> Double? {
        if let number = value as? NSNumber { return number.doubleValue }
        if let number = value as? Double { return number }
        if let number = value as? Int { return Double(number) }
        return nil
    }

    private func duration(start: TimeInterval?, end: TimeInterval?) -> Double? {
        guard let start, let end, end >= start else { return nil }
        return (end - start) * 1_000
    }

    private func addDuration(
        _ metric: inout [String: Any],
        _ key: String,
        _ start: TimeInterval?,
        _ end: TimeInterval?
    ) {
        addNumber(&metric, key, duration(start: start, end: end))
    }

    private func addNumber(_ metric: inout [String: Any], _ key: String, _ value: Double?) {
        guard let value, value.isFinite, value >= 0, value <= maximumDurationMs else { return }
        metric[key] = Int(value.rounded())
    }
}
