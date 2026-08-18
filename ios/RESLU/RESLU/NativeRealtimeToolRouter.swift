import Foundation

struct NativeRealtimeCallContext {
    let callId: String
    let clientCallId: String
    let conversationId: String
    let agentName: String
    let agentSlug: String
    let usesNativeRealtime: Bool
}

@MainActor
final class NativeRealtimeToolRouter {
    private let client: NativeRealtimeHTTPClient
    private let context: NativeRealtimeCallContext
    private let latencyMetrics: NativeRealtimeLatencyMetrics
    private let send: ([String: Any]) -> Void
    private let notifyWeb: ([String: Any]) -> Void
    private var handledToolCallIds = Set<String>()
    private var activeConsult: (id: String, endpoint: String, task: Task<Void, Never>)?
    private var activeResponseId: String?
    private var activeOutputAudioResponseId: String?
    private var progressCueId: String?
    private var progressCueResponseId: String?

    init(
        client: NativeRealtimeHTTPClient,
        context: NativeRealtimeCallContext,
        latencyMetrics: NativeRealtimeLatencyMetrics,
        send: @escaping ([String: Any]) -> Void,
        notifyWeb: @escaping ([String: Any]) -> Void
    ) {
        self.client = client
        self.context = context
        self.latencyMetrics = latencyMetrics
        self.send = send
        self.notifyWeb = notifyWeb
    }

    func stop() {
        if let activeConsult {
            activeConsult.task.cancel()
            cancelConsult(toolCallId: activeConsult.id, endpoint: activeConsult.endpoint)
        }
        activeConsult = nil
    }

    func handle(_ event: [String: Any]) {
        guard let type = event["type"] as? String else { return }
        if type == "response.created", let response = event["response"] as? [String: Any] {
            activeResponseId = response["id"] as? String
            let isProgress = (response["metadata"] as? [String: Any])?["reslu_kind"] as? String == "reslu_progress"
            if let activeResponseId { latencyMetrics.didCreateResponse(activeResponseId, isProgress: isProgress) }
            if isProgress, let metadata = response["metadata"] as? [String: Any] {
                if metadata["reslu_cue_id"] as? String == progressCueId {
                    progressCueResponseId = activeResponseId
                } else if let activeResponseId {
                    send(["type": "response.cancel", "response_id": activeResponseId])
                    send(["type": "output_audio_buffer.clear"])
                    self.activeResponseId = nil
                }
            }
            return
        }
        if type == "output_audio_buffer.started" {
            activeOutputAudioResponseId = event["response_id"] as? String ?? activeResponseId
            latencyMetrics.didStartAudio(responseId: activeOutputAudioResponseId)
            return
        }
        if type == "output_audio_buffer.stopped" || type == "output_audio_buffer.cleared" {
            let responseId = event["response_id"] as? String
            if type == "output_audio_buffer.cleared" { latencyMetrics.didClearAudio(responseId: responseId) }
            if responseId == nil || responseId == activeOutputAudioResponseId {
                activeOutputAudioResponseId = nil
            }
            return
        }
        if type == "input_audio_buffer.speech_started" {
            let interruptedResponseId = activeOutputAudioResponseId ?? activeResponseId
            latencyMetrics.didDetectInterruption(responseId: interruptedResponseId)
            if let responseId = activeResponseId {
                send(["type": "response.cancel", "response_id": responseId])
            }
            if activeResponseId != nil || activeOutputAudioResponseId != nil {
                send(["type": "output_audio_buffer.clear"])
            }
            latencyMetrics.didMuteInterruption(responseId: interruptedResponseId)
            activeResponseId = nil
            activeOutputAudioResponseId = nil
            progressCueId = nil
            progressCueResponseId = nil
            return
        }
        if type == "input_audio_buffer.speech_stopped" {
            latencyMetrics.didStopSpeech()
            return
        }
        if type == "response.function_call_arguments.done" {
            route(
                name: event["name"] as? String,
                toolCallId: event["call_id"] as? String,
                responseId: event["response_id"] as? String,
                arguments: event["arguments"] as? String
            )
            return
        }
        guard type == "response.done", let response = event["response"] as? [String: Any] else { return }
        let responseId = response["id"] as? String
        if responseId == activeResponseId { activeResponseId = nil }
        for output in response["output"] as? [[String: Any]] ?? [] where output["type"] as? String == "function_call" {
            let toolCallId = output["call_id"] as? String
            route(
                name: output["name"] as? String,
                toolCallId: toolCallId,
                responseId: responseId,
                arguments: output["arguments"] as? String
            )
            if let toolCallId,
               ["consult_reslu_agent", "consult_reslu_specialist"].contains(output["name"] as? String ?? ""),
               activeConsult?.id == toolCallId {
                startProgressCue(toolCallId: toolCallId)
            }
        }
    }

    private func route(name: String?, toolCallId: String?, responseId: String?, arguments: String?) {
        guard let name, let toolCallId, !handledToolCallIds.contains(toolCallId) else { return }
        handledToolCallIds.insert(toolCallId)
        latencyMetrics.didReceiveToolCall(toolCallId)
        guard let arguments, let data = arguments.data(using: .utf8),
              let payload = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            sendFailure(toolCallId: toolCallId, message: "I couldn’t understand that request. Please say it again.")
            return
        }
        switch name {
        case "consult_reslu_agent":
            startConsult(toolCallId: toolCallId, responseId: responseId, payload: payload, specialist: false)
        case "consult_reslu_specialist":
            startConsult(toolCallId: toolCallId, responseId: responseId, payload: payload, specialist: true)
        case "start_reslu_task":
            startTask(toolCallId: toolCallId, responseId: responseId, payload: payload)
        case "start_meeting_mode":
            sendFunctionOutput(
                toolCallId: toolCallId,
                output: ["answer": "Open the RESLU screen to review the meeting destination and consent before minutes begin."],
                instruction: "Ask the user to open RESLU so Meeting Mode can confirm consent and its filing destination."
            )
        default:
            sendFailure(toolCallId: toolCallId, message: "That voice action is not available yet.")
        }
    }

    private func startConsult(
        toolCallId: String,
        responseId: String?,
        payload: [String: Any],
        specialist: Bool
    ) {
        guard let query = (payload["query"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !query.isEmpty else {
            sendFailure(toolCallId: toolCallId, message: "I couldn’t understand that request. Please say it again.")
            return
        }
        let targetAgent = specialist ? payload["target_agent_slug"] as? String : nil
        if specialist && (!["aria", "marco", "stuart"].contains(targetAgent ?? "") || targetAgent == context.agentSlug) {
            sendFailure(toolCallId: toolCallId, message: "I couldn’t identify a different RESLU specialist. Please say which agent you want.")
            return
        }
        if let previous = activeConsult {
            previous.task.cancel()
            cancelConsult(toolCallId: previous.id, endpoint: previous.endpoint)
        }
        let endpoint = specialist ? "specialist" : "consult"
        latencyMetrics.didStartConsult(toolCallId)
        let task = Task { [weak self] in
            guard let self else { return }
            do {
                var body: [String: Any] = [
                    "query": query,
                    "call_id": context.callId,
                    "tool_call_id": toolCallId,
                ]
                if let responseId { body["response_id"] = responseId }
                body[specialist ? "owner_agent_slug" : "agent_slug"] = context.agentSlug
                if let targetAgent { body["target_agent_slug"] = targetAgent }
                _ = try await client.json(
                    path: "/api/conversations/\(context.conversationId)/realtime/\(endpoint)",
                    method: "POST",
                    body: body
                )
                latencyMetrics.didAcceptConsult(toolCallId)
                let pollingStartedAt = Date()
                while !Task.isCancelled {
                    let ownerKey = specialist ? "owner_agent_slug" : "agent_slug"
                    let encodedTool = toolCallId.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? toolCallId
                    let status = try await client.json(
                        path: "/api/conversations/\(context.conversationId)/realtime/\(endpoint)?tool_call_id=\(encodedTool)&\(ownerKey)=\(context.agentSlug)"
                    )
                    if status["status"] as? String == "done", let answer = status["answer"] as? String {
                        guard !Task.isCancelled, isActiveConsult(toolCallId) else { return }
                        activeConsult = nil
                        latencyMetrics.didCompleteConsult(toolCallId, latency: status["latency"] as? [String: Any])
                        notifyWeb(["type": "native-consult-completed", "tool_call_id": toolCallId])
                        var output: [String: Any] = ["answer": answer]
                        if specialist {
                            output["consulted_agent"] = status["consulted_agent"] as? String ?? targetAgent
                        }
                        sendFunctionOutput(
                            toolCallId: toolCallId,
                            output: output,
                            instruction: specialist
                                ? "Speak this specialist-informed answer as the owning RESLU agent. Add no facts or actions."
                                : "Speak this existing RESLU agent answer faithfully. Add no facts or actions."
                        )
                        return
                    }
                    if status["status"] as? String == "failed" {
                        throw NativeRealtimeHTTPError.rejected(503, status["error"] as? String ?? "The RESLU agent could not answer.")
                    }
                    if status["status"] as? String == "cancelled" { return }
                    let elapsed = Date().timeIntervalSince(pollingStartedAt)
                    let pollDelay = elapsed < 5 ? 250 : elapsed < 15 ? 500 : 1_000
                    try await Task.sleep(for: .milliseconds(pollDelay))
                }
            } catch is CancellationError {
                latencyMetrics.didCancel(toolCallId)
                return
            } catch {
                guard isActiveConsult(toolCallId) else { return }
                activeConsult = nil
                latencyMetrics.didFail(toolCallId)
                sendFailure(toolCallId: toolCallId, message: "I couldn’t reach the RESLU agent just now. Please try again.")
            }
        }
        activeConsult = (toolCallId, endpoint, task)
    }

    private func isActiveConsult(_ toolCallId: String) -> Bool {
        activeConsult?.id == toolCallId
    }

    private func progressAcknowledgement() -> String {
        let phrases: [String]
        switch context.agentSlug {
        case "marco": phrases = ["On it.", "I’ll get into that.", "I’ll work through it."]
        case "stuart": phrases = ["Right.", "I’ll deal with that.", "Understood."]
        default: phrases = ["I’ll take care of that.", "I’ll pull that together.", "Leave that with me."]
        }
        return phrases[max(0, handledToolCallIds.count - 1) % phrases.count]
    }

    private func startProgressCue(toolCallId: String) {
        guard activeConsult?.id == toolCallId, progressCueId == nil else { return }
        let cueId = UUID().uuidString
        progressCueId = cueId
        latencyMetrics.didRequestProgress(toolCallId)
        let acknowledgement = progressAcknowledgement()
        send([
            "type": "response.create",
            "response": [
                "metadata": ["reslu_kind": "reslu_progress", "reslu_cue_id": cueId],
                "output_modalities": ["audio"],
                "tool_choice": "none",
                "instructions": "Say exactly: \(acknowledgement) Do not add any other words.",
            ],
        ])
    }

    private func stopProgressCue() {
        guard progressCueId != nil else { return }
        if let progressCueResponseId, activeResponseId == progressCueResponseId {
            send(["type": "response.cancel", "response_id": progressCueResponseId])
            activeResponseId = nil
        }
        send(["type": "output_audio_buffer.clear"])
        if activeOutputAudioResponseId == progressCueResponseId { activeOutputAudioResponseId = nil }
        progressCueId = nil
        self.progressCueResponseId = nil
    }

    private func cancelConsult(toolCallId: String, endpoint: String) {
        Task { [client, context] in
            let ownerKey = endpoint == "specialist" ? "owner_agent_slug" : "agent_slug"
            _ = try? await client.json(
                path: "/api/conversations/\(context.conversationId)/realtime/\(endpoint)",
                method: "PATCH",
                body: ["tool_call_id": toolCallId, ownerKey: context.agentSlug]
            )
        }
    }

    private func startTask(toolCallId: String, responseId: String?, payload: [String: Any]) {
        guard
            let title = payload["title"] as? String,
            let objective = payload["objective"] as? String,
            let modelTier = payload["model_tier"] as? String
        else {
            sendFailure(toolCallId: toolCallId, message: "I couldn’t create that task. Please state the outcome you want.")
            return
        }
        Task { [weak self] in
            guard let self else { return }
            do {
                var body: [String: Any] = [
                    "title": title,
                    "objective": objective,
                    "model_tier": modelTier,
                    "agent_slug": context.agentSlug,
                    "call_id": context.callId,
                    "tool_call_id": toolCallId,
                ]
                if let responseId { body["response_id"] = responseId }
                let result = try await client.json(
                    path: "/api/conversations/\(context.conversationId)/realtime/task",
                    method: "POST",
                    body: body
                )
                let acknowledgement = result["acknowledgement"] as? String ?? "I’ve started that work in the background."
                let task = result["task"] as? [String: Any]
                notifyWeb(["type": "native-task-created", "tool_call_id": toolCallId])
                sendFunctionOutput(
                    toolCallId: toolCallId,
                    output: [
                        "task_id": task?["id"] as? String ?? "",
                        "status": task?["status"] as? String ?? "queued",
                        "answer": acknowledgement,
                    ],
                    instruction: "Speak only the start_reslu_task answer. Add no facts, promises or actions."
                )
            } catch {
                sendFailure(toolCallId: toolCallId, message: "I couldn’t start that background task. Please try again.")
            }
        }
    }

    private func sendFailure(toolCallId: String, message: String) {
        latencyMetrics.didFail(toolCallId)
        sendFunctionOutput(
            toolCallId: toolCallId,
            output: ["answer": message, "failed": true],
            instruction: "Speak only this brief failure message. Do not claim the task or lookup succeeded."
        )
    }

    private func sendFunctionOutput(toolCallId: String, output: [String: Any], instruction: String) {
        stopProgressCue()
        let data = (try? JSONSerialization.data(withJSONObject: output)) ?? Data("{}".utf8)
        let encoded = String(data: data, encoding: .utf8) ?? "{}"
        send([
            "type": "conversation.item.create",
            "item": [
                "type": "function_call_output",
                "call_id": toolCallId,
                "output": encoded,
            ],
        ])
        latencyMetrics.didRequestFinalResponse(toolCallId)
        send([
            "type": "response.create",
            "response": [
                "output_modalities": ["audio"],
                "tool_choice": "none",
                "instructions": instruction,
            ],
        ])
    }
}
