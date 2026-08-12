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
    private weak var webView: WKWebView?
    private var callUUID: UUID?
    private var endingFromWeb = false

    override init() {
        let configuration = CXProviderConfiguration(localizedName: "RESLU")
        configuration.supportsVideo = false
        configuration.maximumCallsPerCallGroup = 1
        configuration.maximumCallGroups = 1
        configuration.supportedHandleTypes = [.generic]
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func attach(webView: WKWebView) {
        self.webView = webView
    }

    func detach(webView: WKWebView) {
        if self.webView === webView { self.webView = nil }
    }

    private func configureAudioSession(activate: Bool) throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowAirPlay]
        )
        if activate { try session.setActive(true) }
    }

    private func beginCall(agent: String) {
        guard callUUID == nil else { return }
        do {
            try configureAudioSession(activate: false)
        } catch {
            sendToWeb(type: "native-audio-error", message: error.localizedDescription)
            return
        }

        let uuid = UUID()
        callUUID = uuid
        let handle = CXHandle(type: .generic, value: agent)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        callController.request(CXTransaction(action: action)) { [weak self] error in
            guard let self, let error else { return }
            Task { @MainActor in
                self.callUUID = nil
                self.deactivateAudioSession()
                self.sendToWeb(type: "native-audio-error", message: error.localizedDescription)
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
        callUUID = nil
        let shouldNotify = notifyWeb && !endingFromWeb
        endingFromWeb = false
        deactivateAudioSession()
        if shouldNotify { sendToWeb(type: "end-requested") }
    }

    private func deactivateAudioSession() {
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    private func sendToWeb(type: String, message: String? = nil, muted: Bool? = nil) {
        var payload: [String: Any] = ["type": type]
        if let message { payload["message"] = message }
        if let muted { payload["muted"] = muted }
        guard
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        webView?.evaluateJavaScript(
            "window.dispatchEvent(new CustomEvent('reslu-native-voice',{detail:\(json)}))"
        )
    }
}

extension VoiceSessionCoordinator: WKScriptMessageHandler {
    nonisolated func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName, let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        Task { @MainActor in
            switch type {
            case "call.start":
                beginCall(agent: body["agent"] as? String ?? "RESLU Agent")
            case "call.connected":
                markConnected()
            case "call.muted":
                setMutedFromWeb(body["muted"] as? Bool ?? false)
            case "call.end":
                endCallFromWeb()
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
            sendToWeb(type: "mute-requested", muted: action.isMuted)
            action.fulfill()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in
            guard callUUID != nil else { return }
            // WebRTC owns media; this callback is CallKit's authoritative signal
            // that iOS is ready for the web layer to open microphone capture.
            sendToWeb(type: "native-audio-ready")
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in deactivateAudioSession() }
    }
}
