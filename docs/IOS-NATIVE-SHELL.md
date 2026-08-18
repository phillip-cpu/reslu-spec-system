# RESLU iPhone native voice shell

Status: Stage 5 foundation implemented and signed; physical-device install and
acceptance remain.

## Decision

The Home Screen web app cannot satisfy the locked-screen call gate. Browser-only
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
- WebRTC microphone capture waits for CallKit's authoritative `didActivate`
  callback instead of racing the native audio session during call startup.
- Reconnect remains foreground-only in Safari/PWA, but the trusted native shell
  may make the same bounded attempts while backgrounded or locked.
- The system CallKit mute action updates the canonical web microphone track (or
  legacy recognition fallback), so the lock-screen control and RESLU agree.
- The bridge carries call lifecycle only: start, connected, end and a native
  end request. It is not a second agent or tool system.

OpenAI recommends WebRTC for client connections including mobile devices. Apple
requires an appropriate audio session and background capability for audio to
continue when an app backgrounds or the device locks. CallKit coordinates a
VoIP call with system call behavior and signals actual audio activation through
`CXProviderDelegate.provider(_:didActivate:)`; RESLU waits for that signal with
a bounded five-second failure path before opening browser media capture.

## Generate the Xcode project

This laptop has Xcode 26.6, the iOS 26.5 SDK and XcodeGen. The checked-in source
can be regenerated and compiled with:

1. From the repository root, run `bash scripts/verify-ios-shell.sh`. This
   generates the Xcode project and performs an unsigned simulator compile.
2. Connect and unlock the paired physical iPhone. From the repository root run
   `bash scripts/install-ios-shell.sh <device identifier>` using the identifier
   shown by `xcrun devicectl list devices`. The installer fails before building
   if Developer Mode or the CoreDevice tunnel is unavailable; otherwise it
   performs a signed device build, installs the exact bundle and launches it.
3. If manual Xcode inspection is needed, open `ios/RESLU/RESLU.xcodeproj`, select
   the RESLU target and confirm team `3THNC3HJ63` and bundle identifier
   `au.com.reslu.spec` before running on the connected phone.

On 18 August 2026, CoreDevice reported Phillip's iPhone 15 Pro Max as paired
with Developer Mode enabled. A generic iPhone Debug build compiled and signed
successfully with team `3THNC3HJ63`, bundle `au.com.reslu.spec` and a profile
containing that phone's UDID. The profile expires 25 August 2026. Installation
could not start because the phone's CoreDevice tunnel was unavailable; connect
and unlock the phone before repeating the install.

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
