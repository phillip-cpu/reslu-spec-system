import SwiftUI
import UIKit
import WebKit

private let resluURL = URL(string: "https://spec.reslu.com.au/messages")!
private let trustedMediaHost = "spec.reslu.com.au"

struct RESLUWebView: UIViewRepresentable {
    @ObservedObject var voiceSession: VoiceSessionCoordinator

    func makeCoordinator() -> Coordinator {
        Coordinator(voiceSession: voiceSession)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        configuration.userContentController.add(voiceSession, name: VoiceSessionCoordinator.handlerName)

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .automatic
        voiceSession.attach(webView: webView)
        webView.load(URLRequest(url: resluURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    static func dismantleUIView(_ webView: WKWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: VoiceSessionCoordinator.handlerName)
        coordinator.voiceSession.detach(webView: webView)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        let voiceSession: VoiceSessionCoordinator

        init(voiceSession: VoiceSessionCoordinator) {
            self.voiceSession = voiceSession
        }

        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.scheme == "about" || url.host == trustedMediaHost {
                decisionHandler(.allow)
            } else {
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            }
        }

        @available(iOS 15.0, *)
        func webView(
            _ webView: WKWebView,
            requestMediaCapturePermissionFor origin: WKSecurityOrigin,
            initiatedByFrame frame: WKFrameInfo,
            type: WKMediaCaptureType,
            decisionHandler: @escaping (WKPermissionDecision) -> Void
        ) {
            decisionHandler(origin.host == trustedMediaHost ? .grant : .deny)
        }
    }
}
