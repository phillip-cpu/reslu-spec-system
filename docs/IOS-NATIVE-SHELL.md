# RESLU iPhone native voice shell

Status: Stage 5 foundation implemented; Xcode signing and physical-device
acceptance remain.

## Decision

The Home Screen web app cannot satisfy the locked-screen call gate. RESLU's web
reconnect intentionally waits until the document is visible, and a web manifest
cannot configure `AVAudioSession`, iOS background audio or CallKit. More browser
retry tuning would only make foreground recovery better; it cannot create the
operating-system privileges needed for a dependable in-car call.

The first native slice is therefore a thin SwiftUI/WKWebView shell:

- `https://spec.reslu.com.au/messages` remains the authenticated application.
- Supabase cookies stay in the persistent WebKit data store; no token or OpenAI
  key is copied into Swift.
- The existing RESLU API creates the OpenAI WebRTC session with the server key.
- Existing conversation IDs, call records, messages, tasks, Aria/Marco routing,
  OpenClaw sessions, memory, permissions and persistence remain canonical.
- Native code owns `AVAudioSession`, CallKit and the background modes that web
  code cannot request.
- The bridge carries call lifecycle only: start, connected, end and a native
  end request. It is not a second agent or tool system.

OpenAI recommends WebRTC for client connections including mobile devices. Apple
requires an appropriate audio session and background capability for audio to
continue when an app backgrounds or the device locks. CallKit coordinates a
VoIP call with system call behavior and audio activation.

## Generate the Xcode project

This laptop currently has Command Line Tools but not the full Xcode iOS SDK, so
the checked-in source is generated with XcodeGen once Xcode is installed:

1. Install current Xcode from the App Store and open it once.
2. Run `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`.
3. Install XcodeGen with `brew install xcodegen`.
4. From the repository root, run `bash scripts/verify-ios-shell.sh`. This
   generates the Xcode project and performs an unsigned simulator compile.
5. Open `ios/RESLU/RESLU.xcodeproj`.
6. Select the RESLU target, choose Phillip's Apple Developer team and confirm
   the bundle identifier `au.com.reslu.spec` is available.
7. Connect the physical iPhone, trust the developer certificate and run.

No API secret belongs in the Xcode project. The user signs into the normal RESLU
page once inside the app.

## Physical-device gate

Run each case on the production backend and save the call ID plus timestamps:

1. Start an Aria call, ask a contextual question and confirm canonical thread
   persistence.
2. Lock the phone for 60 seconds while listening and speaking; confirm audio and
   microphone continue without creating a second call record.
3. Switch between speaker, Bluetooth and the handset route.
4. Move Wi-Fi to 5G and back during the same call.
5. Use the lock-screen/system end-call action and confirm RESLU appends one
   truthful call record.
6. Start durable agent work, end the call and confirm the task keeps running.
7. Force one recoverable transport loss and confirm the same canonical call ID
   resumes without replaying a request or duplicating a message.

If WebKit suspends its WebRTC peer despite the native audio session and CallKit,
the next slice moves the peer/audio transport into native code. The bridge and
server API boundary deliberately allow that change without rebuilding chat,
tools, memory or agent routing.

## Sources

- OpenAI Realtime WebRTC: https://developers.openai.com/api/docs/guides/realtime-webrtc
- Apple background audio: https://developer.apple.com/documentation/AVFoundation/configuring-your-app-for-media-playback
- Apple VoIP/CallKit: https://developer.apple.com/documentation/callkit/making-and-receiving-voip-calls
