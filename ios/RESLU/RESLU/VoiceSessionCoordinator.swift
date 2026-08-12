import AVFAudio
import CallKit
import Combine
import Foundation
import WebKit

@MainActor
final class VoiceSessionCoordinator: NSObject, ObservableObject {
    nonisolated static let handlerName = "resluVoice"

    private let callController = CXCallController()
    private let provider: CXProvider
    private let realtimeHTTPClient = NativeRealtimeHTTPClient()
    private let continuity = NativeVoiceContinuityMetrics()
    private lazy var realtimeTransport = NativeRealtimeTransport(
        client: realtimeHTTPClient,
        continuity: continuity,
        delegate: self
    )
    private weak var webView: WKWebView?
    private var callUUID: UUID?
    private var callContext: NativeRealtimeCallContext?
    private var endingFromWeb = false
    private var webReady = false
    private var webDocumentReady = false
    private var appIsBackgrounded = false
    private var pendingWebPayloads = [[String: Any]]()
    private let maximumPendingWebPayloads = 80

    private func trace(_ message: String) {
        print("[RESLU voice bridge] \(message)")
    }

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(audioRouteDidChange),
            name: AVAudioSession.routeChangeNotification,
            object: nil
        )
    }

    func attach(webView: WKWebView) {
        self.webView = webView
        webReady = false
        webDocumentReady = false
        realtimeHTTPClient.attach(cookieStore: webView.configuration.websiteDataStore.httpCookieStore)
    }

    func detach(webView: WKWebView) {
        if self.webView === webView {
            self.webView = nil
            webReady = false
            webDocumentReady = false
        }
    }

    func appDidBecomeActive() {
        appIsBackgrounded = false
        if webDocumentReady { webReady = true }
        flushPendingWebPayloads()
        Task { await realtimeHTTPClient.flushPendingCallEnds() }
    }

    func appDidEnterBackground() {
        appIsBackgrounded = true
        webReady = false
        if callUUID != nil { continuity.didEnterBackground() }
    }

    func webWillNavigate() {
        webReady = false
        webDocumentReady = false
    }

    func webDidFinishNavigation() {
        // Older deployed web clients do not post the v2 `web.ready` bridge
        // event. WKNavigationDelegate still tells us the page can receive
        // native lifecycle acknowledgements.
        markWebReady()
        trace("web navigation finished; bridge ready")
    }

    private func configureAudioSession(activate: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetoothHFP, .allowAirPlay]
        )
        if activate { try session.setActive(true) }
    }

    private func beginCall(context: NativeRealtimeCallContext) {
        trace("begin call; nativeRealtime=\(context.usesNativeRealtime)")
        guard callUUID == nil else { return }
        continuity.reset()
        if context.usesNativeRealtime {
            realtimeTransport.setMuted(false)
        }
        do {
            try configureAudioSession(activate: false)
        } catch {
            sendToWeb(type: "native-audio-error", message: error.localizedDescription)
            return
        }

        let uuid = UUID()
        callUUID = uuid
        callContext = context
        let handle = CXHandle(type: .generic, value: context.agentName)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let self, let error else { return }
            Task { @MainActor in
                let failedCallId = self.callContext?.callId
                self.callUUID = nil
                self.callContext = nil
                self.deactivateAudioSession()
                self.sendToWeb(type: "native-audio-error", message: error.localizedDescription, callId: failedCallId)
            }
        }
    }

    private func markConnected() {
        guard let callUUID else { return }
        provider.reportOutgoingCall(with: callUUID, connectedAt: Date())
    }

    private func setMutedFromWeb(_ muted: Bool) {
        guard let callUUID else { return }
        let action = CXSetMutedCallAction(call: callUUID, muted: muted)
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let self, let error else { return }
            Task { @MainActor in
                self.sendToWeb(type: "mute-sync-error", message: error.localizedDescription)
            }
        }
    }

    private func endCallFromWeb() {
        guard let callUUID else {
            deactivateAudioSession()
            return
        }
        endingFromWeb = true
        callController.request(CXTransaction(action: CXEndCallAction(call: callUUID))) { [weak self] error in
            guard let self, error != nil else { return }
            Task { @MainActor in self.finishCall(notifyWeb: false) }
        }
    }

    private func finishCall(notifyWeb: Bool) {
        let endedCallId = callContext?.callId
        if appIsBackgrounded { continuity.didEndWhileBackground() }
        let nativeContinuity = continuity.payload
        if let callContext, callContext.usesNativeRealtime {
            realtimeHTTPClient.endCall(
                conversationId: callContext.conversationId,
                callId: callContext.callId,
                nativeContinuity: nativeContinuity
            )
        }
        if callContext?.usesNativeRealtime == true {
            realtimeTransport.stop()
        }
        callUUID = nil
        callContext = nil
        let shouldNotify = notifyWeb && !endingFromWeb
        endingFromWeb = false
        deactivateAudioSession()
        if shouldNotify { sendToWeb(type: "end-requested", callId: endedCallId) }
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func shouldBufferForWeb(_ payload: [String: Any]) -> Bool {
        guard payload["type"] as? String == "native-realtime-event" else { return true }
        guard let event = payload["event"] as? [String: Any], let eventType = event["type"] as? String else { return false }
        return [
            "conversation.item.input_audio_transcription.completed",
            "response.output_audio_transcript.done",
            "native-task-created",
            "native-consult-completed",
            "response.done",
            "error",
        ].contains(eventType)
    }

    private func enqueueWebPayload(_ payload: [String: Any]) {
        guard shouldBufferForWeb(payload) else { return }
        if let type = payload["type"] as? String, type != "native-realtime-event" {
            pendingWebPayloads.removeAll { $0["type"] as? String == type }
        }
        pendingWebPayloads.append(payload)
        if pendingWebPayloads.count > maximumPendingWebPayloads {
            pendingWebPayloads.removeFirst(pendingWebPayloads.count - maximumPendingWebPayloads)
        }
        continuity.didBufferWebEvents(pendingWebPayloads.count)
    }

    private func deliverToWeb(_ payload: [String: Any]) {
        let payloadType = payload["type"] as? String ?? "unknown"
        guard webReady, let webView else {
            trace("buffer web event \(payloadType); webReady=\(webReady)")
            enqueueWebPayload(payload)
            return
        }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('reslu-native-voice',{detail:\(json)}))"
        ) { [weak self] _, error in
            guard let self else { return }
            Task { @MainActor in
                if let error {
                    self.trace("web event \(payloadType) failed: \(error.localizedDescription)")
                    self.enqueueWebPayload(payload)
                } else {
                    self.trace("web event \(payloadType) delivered")
                }
            }
        }
    }

    private func flushPendingWebPayloads() {
        guard webReady, webView != nil, !pendingWebPayloads.isEmpty else { return }
        let payloads = pendingWebPayloads
        pendingWebPayloads.removeAll(keepingCapacity: true)
        continuity.didReplayWebEvents(payloads.count)
        payloads.forEach(deliverToWeb)
    }

    private func markWebReady() {
        webDocumentReady = true
        webReady = true
        flushPendingWebPayloads()
    }

    @objc private func audioRouteDidChange(_ notification: Notification) {
        if callUUID != nil { continuity.didChangeAudioRoute() }
    }

    private func sendToWeb(
        type: String,
        message: String? = nil,
        muted: Bool? = nil,
        event: [String: Any]? = nil,
        callId: String? = nil
    ) {
        var payload: [String: Any] = ["type": type]
        if let message { payload["message"] = message }
        if let muted { payload["muted"] = muted }
        if let event { payload["event"] = event }
        if let callId = callId ?? callContext?.callId { payload["callId"] = callId }
        deliverToWeb(payload)
    }
}

extension VoiceSessionCoordinator: WKScriptMessageHandler {
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        Task { @MainActor in
            trace("received web message \(type)")
            switch type {
            case "call.start":
                let usesNativeRealtime = body["transport"] as? String == "native-realtime"
                if usesNativeRealtime && (
                    body["callId"] as? String == nil ||
                    body["clientCallId"] as? String == nil ||
                    body["conversationId"] as? String == nil ||
                    body["agentSlug"] as? String == nil
                ) {
                    sendToWeb(type: "native-realtime-error", message: "The native call details were incomplete.")
                    return
                }
                let agentName = body["agent"] as? String ?? "RESLU Agent"
                let callId = body["callId"] as? String ?? "legacy-pending"
                let context = NativeRealtimeCallContext(
                    callId: callId,
                    clientCallId: body["clientCallId"] as? String ?? UUID().uuidString,
                    conversationId: body["conversationId"] as? String ?? "",
                    agentName: agentName,
                    agentSlug: body["agentSlug"] as? String ?? agentName.lowercased(),
                    usesNativeRealtime: usesNativeRealtime
                )
                if !context.usesNativeRealtime {
                    // Receiving this message proves the legacy page and its
                    // event listener are alive. Release browser-owned WebRTC
                    // immediately and let CallKit presentation continue in
                    // parallel; otherwise iOS can create a circular wait.
                    markWebReady()
                    trace("release legacy web audio immediately")
                    sendToWeb(type: "native-audio-ready", callId: callId)
                }
                beginCall(context: context)
            case "call.connected":
                markConnected()
            case "call.muted":
                setMutedFromWeb(body["muted"] as? Bool ?? false)
            case "call.end":
                endCallFromWeb()
            case "realtime.event":
                if let event = body["event"] as? [String: Any] { realtimeTransport.send(event) }
            case "web.ready":
                markWebReady()
            default:
                break
            }
        }
    }
}

extension VoiceSessionCoordinator: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in finishCall(notifyWeb: true) }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            do {
                try configureAudioSession(activate: false)
                provider.reportOutgoingCall(with: action.callUUID, startedConnectingAt: Date())
                action.fulfill()
                // The currently deployed web client owns its WebRTC peer and
                // waits for this bridge acknowledgement before requesting the
                // microphone. Waiting for didActivate here creates a cycle:
                // WebKit cannot connect until acknowledged, while CallKit may
                // not activate until WebKit reports the call connected. Only
                // the legacy web-audio path gets this early acknowledgement;
                // native Realtime still starts exclusively from didActivate.
                if callContext?.usesNativeRealtime == false {
                    sendToWeb(type: "native-audio-ready")
                }
            } catch {
                action.fail()
                finishCall(notifyWeb: true)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            finishCall(notifyWeb: true)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            guard callUUID == action.callUUID else {
                action.fail()
                return
            }
            if callContext?.usesNativeRealtime == true {
                realtimeTransport.setMuted(action.isMuted)
            }
            continuity.didChangeMute()
            sendToWeb(type: "mute-requested", muted: action.isMuted)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in
            guard callUUID != nil else { return }
            continuity.didActivateCallKitAudio()
            // Keep the installed shell compatible with the deployed web app.
            // Older clients wait for this acknowledgement before starting
            // browser-owned audio; native-Realtime clients ignore it while
            // they wait for native-realtime-connected.
            sendToWeb(type: "native-audio-ready")
            if let callContext, callContext.usesNativeRealtime {
                realtimeTransport.setAudioActive(true)
                realtimeTransport.start(context: callContext)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in
            if callContext?.usesNativeRealtime == true {
                realtimeTransport.setAudioActive(false)
            }
            deactivateAudioSession()
        }
    }
}

extension VoiceSessionCoordinator: NativeRealtimeTransportDelegate {
    func nativeRealtimeDidConnect() {
        markConnected()
        sendToWeb(type: "native-realtime-connected")
    }

    func nativeRealtimeDidReceive(event: [String: Any]) {
        sendToWeb(type: "native-realtime-event", event: event)
    }

    func nativeRealtimeDidFail(message: String) {
        sendToWeb(type: "native-realtime-error", message: message)
        endCallFromWeb()
    }
}
