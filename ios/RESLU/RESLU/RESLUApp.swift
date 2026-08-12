import SwiftUI

@main
struct RESLUApp: App {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var voiceSession = VoiceSessionCoordinator()

    var body: some Scene {
        WindowGroup {
            RESLUWebView(voiceSession: voiceSession)
                .ignoresSafeArea(.container, edges: .bottom)
                .onChange(of: scenePhase) { phase in
                    if phase == .active { voiceSession.appDidBecomeActive() }
                    else if phase == .background { voiceSession.appDidEnterBackground() }
                }
        }
    }
}
