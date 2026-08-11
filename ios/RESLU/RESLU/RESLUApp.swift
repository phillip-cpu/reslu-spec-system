import SwiftUI

@main
struct RESLUApp: App {
    @StateObject private var voiceSession = VoiceSessionCoordinator()

    var body: some Scene {
        WindowGroup {
            RESLUWebView(voiceSession: voiceSession)
                .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}
