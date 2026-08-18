import Foundation
import WebRTC

@MainActor
protocol NativeRealtimeTransportDelegate: AnyObject {
    func nativeRealtimeDidConnect()
    func nativeRealtimeDidReceive(event: [String: Any])
    func nativeRealtimeDidFail(message: String)
}

@MainActor
final class NativeRealtimeTransport: NSObject {
    private let client: NativeRealtimeHTTPClient
    private let continuity: NativeVoiceContinuityMetrics
    private let latencyMetrics = NativeRealtimeLatencyMetrics()
    private weak var delegate: NativeRealtimeTransportDelegate?
    private let factory: RTCPeerConnectionFactory
    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var audioTrack: RTCAudioTrack?
    private var router: NativeRealtimeToolRouter?
    private var context: NativeRealtimeCallContext?
    private var connectionTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var disconnectedTask: Task<Void, Never>?
    private var reconnectAttempts = 0
    private var stopped = false
    private var muted = false

    init(
        client: NativeRealtimeHTTPClient,
        continuity: NativeVoiceContinuityMetrics,
        delegate: NativeRealtimeTransportDelegate
    ) {
        self.client = client
        self.continuity = continuity
        self.delegate = delegate
        RTCInitializeSSL()
        factory = RTCPeerConnectionFactory()
        super.init()
        let audioSession = RTCAudioSession.sharedInstance()
        audioSession.useManualAudio = true
        audioSession.isAudioEnabled = false
    }

    deinit {
        RTCCleanupSSL()
    }

    func start(context: NativeRealtimeCallContext) {
        if self.context?.callId == context.callId, !stopped {
            RTCAudioSession.sharedInstance().isAudioEnabled = true
            return
        }
        stop()
        latencyMetrics.reset()
        stopped = false
        reconnectAttempts = 0
        RTCAudioSession.sharedInstance().isAudioEnabled = true
        self.context = context
        connect(context: context)
    }

    private func connect(context: NativeRealtimeCallContext) {
        tearDownConnection()
        connectionTask = Task { [weak self] in
            guard let self else { return }
            do {
                let configuration = RTCConfiguration()
                configuration.sdpSemantics = .unifiedPlan
                configuration.continualGatheringPolicy = .gatherContinually
                let constraints = RTCMediaConstraints(
                    mandatoryConstraints: nil,
                    optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
                )
                guard let peer = factory.peerConnection(
                    with: configuration,
                    constraints: constraints,
                    delegate: self
                ) else { throw NativeRealtimeHTTPError.unavailable }
                self.peer = peer

                let source = factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
                let audioTrack = factory.audioTrack(with: source, trackId: "reslu-microphone")
                audioTrack.isEnabled = !muted
                self.audioTrack = audioTrack
                _ = peer.add(audioTrack, streamIds: ["reslu-call"])

                let dataConfiguration = RTCDataChannelConfiguration()
                dataConfiguration.isOrdered = true
                guard let channel = peer.dataChannel(forLabel: "oai-events", configuration: dataConfiguration) else {
                    throw NativeRealtimeHTTPError.unavailable
                }
                channel.delegate = self
                self.channel = channel
                self.router = NativeRealtimeToolRouter(
                    client: client,
                    context: context,
                    latencyMetrics: latencyMetrics,
                    send: { [weak self] event in self?.send(event) },
                    notifyWeb: { [weak self] event in self?.delegate?.nativeRealtimeDidReceive(event: event) }
                )

                let offer = try await createOffer(peer)
                try await setLocalDescription(offer, on: peer)
                let answer = try await client.createRealtimeSession(
                    conversationId: context.conversationId,
                    agentSlug: context.agentSlug,
                    offer: offer.sdp
                )
                try await setRemoteDescription(RTCSessionDescription(type: .answer, sdp: answer), on: peer)
            } catch is CancellationError {
                return
            } catch {
                guard !stopped else { return }
                scheduleReconnect(lastError: error.localizedDescription)
            }
        }
    }

    func stop() {
        stopped = true
        connectionTask?.cancel()
        connectionTask = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        disconnectedTask?.cancel()
        disconnectedTask = nil
        tearDownConnection()
        context = nil
        RTCAudioSession.sharedInstance().isAudioEnabled = false
    }

    private func tearDownConnection() {
        router?.stop()
        router = nil
        channel?.delegate = nil
        channel?.close()
        channel = nil
        peer?.close()
        peer = nil
        audioTrack = nil
    }

    private func scheduleReconnect(lastError: String) {
        guard !stopped, reconnectTask == nil, let context else { return }
        guard reconnectAttempts < 3 else {
            delegate?.nativeRealtimeDidFail(message: lastError)
            return
        }
        reconnectAttempts += 1
        continuity.didAttemptReconnect()
        let delay = reconnectAttempts * 500
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(delay))
            guard let self, !Task.isCancelled, !stopped else { return }
            reconnectTask = nil
            connect(context: context)
        }
    }

    private func waitForDisconnectedPeer(_ disconnectedPeer: RTCPeerConnection) {
        guard !stopped, disconnectedTask == nil else { return }
        disconnectedTask = Task { [weak self, weak disconnectedPeer] in
            try? await Task.sleep(for: .seconds(4))
            guard let self, let disconnectedPeer, !Task.isCancelled, !stopped else { return }
            disconnectedTask = nil
            if disconnectedPeer === peer && disconnectedPeer.iceConnectionState == .disconnected {
                scheduleReconnect(lastError: "The realtime network handoff did not recover.")
            }
        }
    }

    private func clearDisconnectedPeerWait() {
        disconnectedTask?.cancel()
        disconnectedTask = nil
    }

    func setAudioActive(_ active: Bool) {
        RTCAudioSession.sharedInstance().isAudioEnabled = active
    }

    func setMuted(_ muted: Bool) {
        self.muted = muted
        audioTrack?.isEnabled = !muted
    }

    var voiceLatencyMetrics: [[String: Any]] {
        latencyMetrics.payload
    }

    func send(_ event: [String: Any]) {
        guard
            let channel,
            channel.readyState == .open,
            JSONSerialization.isValidJSONObject(event),
            let data = try? JSONSerialization.data(withJSONObject: event)
        else { return }
        _ = channel.sendData(RTCDataBuffer(data: data, isBinary: false))
    }

    private func createOffer(_ peer: RTCPeerConnection) async throws -> RTCSessionDescription {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<RTCSessionDescription, Error>) in
            peer.offer(for: RTCMediaConstraints(
                mandatoryConstraints: [
                    "OfferToReceiveAudio": "true",
                    "OfferToReceiveVideo": "false",
                ],
                optionalConstraints: nil
            )) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: NativeRealtimeHTTPError.invalidResponse) }
            }
        }
    }

    private func setLocalDescription(_ description: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func setRemoteDescription(_ description: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }
}

extension NativeRealtimeTransport: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        Task { @MainActor in
            guard dataChannel === channel else { return }
            if dataChannel.readyState == .open {
                reconnectAttempts = 0
                continuity.didOpenDataChannel()
                delegate?.nativeRealtimeDidConnect()
            }
            else if dataChannel.readyState == .closed, !stopped {
                scheduleReconnect(lastError: "The realtime audio connection closed.")
            }
        }
    }

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard !buffer.isBinary,
              let object = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        Task { @MainActor in
            guard dataChannel === channel, !stopped else { return }
            router?.handle(object)
            delegate?.nativeRealtimeDidReceive(event: object)
        }
    }
}

extension NativeRealtimeTransport: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor in
            guard peerConnection === peer, !stopped else { return }
            switch newState {
            case .failed:
                clearDisconnectedPeerWait()
                scheduleReconnect(lastError: "The realtime network connection failed.")
            case .disconnected:
                waitForDisconnectedPeer(peerConnection)
            case .connected, .completed, .closed:
                clearDisconnectedPeerWait()
            default:
                break
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        Task { @MainActor in
            guard channel == nil else { return }
            channel = dataChannel
            dataChannel.delegate = self
        }
    }
}
