# RESLU iPhone shell

This target keeps the production RESLU web interface and canonical server data,
but moves active-call media out of `WKWebView`. The version-two shell owns:

- CallKit lifecycle, system mute/end and the `playAndRecord` voice-chat session;
- a pinned native libwebrtc peer, microphone track, remote audio and `oai-events`
  data channel that may continue while the phone is locked;
- authenticated calls to the existing RESLU SDP, consultation, specialist and
  durable-task endpoints using the signed-in web cookie store; and
- idempotent call closure when the call ends from the lock screen; and
- bounded replay of final captions, task/consult refreshes and CallKit state
  after WebKit resumes, scoped to the same canonical call id.

The app contains no OpenAI key and does not recreate Aria, Marco or Stuart.
`OPENAI_API_KEY`, the Realtime session instructions and all canonical agent/tool
logic remain on the RESLU server. The native tool router only completes the
same bounded Realtime function calls that the foreground web client completes,
which keeps a spoken task or consultation alive while WebKit is suspended.

## Build

1. Install and open Xcode once, accept its licence and install requested
   components.
2. Install XcodeGen with `brew install xcodegen`.
3. From the repository root run `bash scripts/verify-ios-shell.sh`. The verifier
   downloads WebRTC with resume support, verifies the release SHA-256 and keeps
   the generated XCFramework out of Git, then compiles an unsigned generic
   iPhone build without requiring a simulator runtime.
4. On the iPhone enable **Settings → Privacy & Security → Developer Mode**,
   approve the restart, then confirm **Turn On** after reboot. Pair the unlocked
   phone with Xcode.
5. The checked-in XcodeGen definition uses Phillip's Personal Team for local
   device testing. Open `ios/RESLU/RESLU.xcodeproj`, choose the attached iPhone,
   then run the RESLU scheme. This does not publish an App Store build.

The bootstrap pins `stasel/WebRTC` 151.0.0 and its published SHA-256 rather than
tracking a branch. That package distributes unmodified libwebrtc binaries built
from the official WebRTC source under the BSD licence. Review and deliberately
update both the release and checksum; never accept an automatic upgrade during
a production hotfix.

## Physical acceptance

One call must pass all of the following before Stage 5 can move from pending:

1. Start Aria from an existing thread and ask a contextual question.
2. Press the side button during her answer; audio must continue and barge-in
   must stop her promptly.
3. While locked, ask for a durable task and hear the truthful acknowledgement;
   the task must remain visible in the same thread after unlock.
4. Use the lock-screen mute and end controls; the canonical call must close once.
5. Repeat over Bluetooth, then move between Wi-Fi and mobile data without stale
   audio, duplicate tool output or a second call record.
