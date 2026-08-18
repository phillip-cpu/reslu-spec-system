import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const project = read("ios/RESLU/project.yml");
const info = read("ios/RESLU/RESLU/Info.plist");
const app = read("ios/RESLU/RESLU/RESLUApp.swift");
const webView = read("ios/RESLU/RESLU/RESLUWebView.swift");
const voice = read("ios/RESLU/RESLU/VoiceSessionCoordinator.swift");
const nativeTransport = read("ios/RESLU/RESLU/NativeRealtimeTransport.swift");
const nativeHTTP = read("ios/RESLU/RESLU/NativeRealtimeHTTPClient.swift");
const nativeTools = read("ios/RESLU/RESLU/NativeRealtimeToolRouter.swift");
const nativeLatency = read("ios/RESLU/RESLU/NativeRealtimeLatencyMetrics.swift");
const nativeContinuity = read("ios/RESLU/RESLU/NativeVoiceContinuityMetrics.swift");
const bridge = read("lib/native-voice-bridge.ts");
const recovery = read("lib/realtime-call-recovery.ts");
const wakeLock = read("lib/call-screen-wake-lock.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const verifier = read("scripts/verify-ios-shell.sh");
const prepareWebRTC = read("scripts/prepare-ios-webrtc.sh");

test("the native target is an iPhone shell with explicit call background modes", () => {
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: au\.com\.reslu\.spec/);
  assert.match(project, /platform: iOS/);
  assert.match(project, /WebRTC:[\s\S]*path: Packages\/WebRTC/);
  assert.match(info, /NSMicrophoneUsageDescription/);
  assert.match(info, /NSCameraUsageDescription/);
  assert.match(info, /UIBackgroundModes[\s\S]*<string>audio<\/string>[\s\S]*<string>voip<\/string>/);
});

test("native iOS owns lock-safe WebRTC audio and CallKit without duplicating RESLU agent logic", () => {
  assert.match(voice, /setCategory\([\s\S]*\.playAndRecord[\s\S]*mode: \.voiceChat/);
  assert.match(voice, /CXProvider/);
  assert.match(voice, /CXStartCallAction/);
  assert.match(voice, /CXEndCallAction/);
  assert.match(voice, /CXSetMutedCallAction/);
  assert.match(voice, /case "call\.muted"[\s\S]*setMutedFromWeb/);
  assert.match(voice, /case "call\.audio-route"[\s\S]*setAudioRouteFromWeb/);
  assert.match(voice, /route == "speaker" \|\| route == "automatic"/);
  assert.match(voice, /overrideOutputAudioPort\(wantsSpeaker \? \.speaker : \.none\)/);
  assert.match(voice, /audio-route-changed/);
  assert.match(voice, /audio-route-error/);
  assert.match(voice, /mute-requested/);
  assert.match(voice, /mute-sync-error/);
  assert.match(voice, /reportOutgoingCall/);
  assert.match(voice, /didActivate audioSession:[\s\S]*realtimeTransport\.start/);
  assert.match(
    voice,
    /didActivate audioSession:[\s\S]*callContext\.usesNativeRealtime[\s\S]*setAudioActive\(true\)[\s\S]*realtimeTransport\.start/,
  );
  assert.match(voice, /if callContext\?\.usesNativeRealtime == true[\s\S]*realtimeTransport\.stop/);
  assert.match(voice, /didActivate audioSession:[\s\S]*sendToWeb\(type: "native-audio-ready"\)/);
  assert.match(voice, /callContext\.usesNativeRealtime/);
  assert.match(voice, /action\.fulfill\(\)[\s\S]*usesNativeRealtime == false[\s\S]*native-audio-ready/);
  assert.match(voice, /func webDidFinishNavigation\(\)[\s\S]*markWebReady\(\)/);
  assert.match(
    voice,
    /case "call\.start":[\s\S]*!context\.usesNativeRealtime[\s\S]*markWebReady\(\)[\s\S]*native-audio-ready[\s\S]*beginCall\(context: context\)/,
  );
  assert.match(voice, /let usesNativeRealtime[\s\S]*if usesNativeRealtime &&[\s\S]*legacy-pending/);
  assert.match(voice, /if let callContext, callContext\.usesNativeRealtime[\s\S]*realtimeHTTPClient\.endCall/);
  assert.doesNotMatch(voice, /perform action: CXStartCallAction[\s\S]*configureAudioSession\(activate: true\)/);
  assert.match(nativeTransport, /RTCPeerConnectionFactory/);
  assert.match(nativeTransport, /dataChannel\(forLabel: "oai-events"/);
  assert.match(nativeTransport, /RTCAudioSession\.sharedInstance\(\)\.isAudioEnabled/);
  assert.match(nativeTransport, /scheduleReconnect/);
  assert.match(nativeTransport, /reconnectAttempts < 3/);
  assert.match(nativeTransport, /iceConnectionState == \.disconnected/);
  assert.match(nativeTransport, /Task\.sleep\(for: \.seconds\(4\)\)/);
  assert.match(nativeTransport, /self\.context\?\.callId == context\.callId, !stopped/);
  assert.match(nativeTransport, /audioTrack\.isEnabled = !muted/);
  assert.match(nativeTools, /elapsed < 5 \? 250 : elapsed < 15 \? 500 : 1_000/);
  assert.match(nativeContinuity, /transport": "native_webrtc_callkit"/);
  assert.match(nativeContinuity, /peakBufferedWebEvents = min\(80/);
  assert.doesNotMatch(`${voice}\n${webView}\n${nativeTransport}\n${nativeHTTP}\n${nativeTools}`, /OPENAI_API_KEY|api\.openai\.com|openclaw/i);
});

test("the CallKit coordinator survives SwiftUI scene and lock-screen transitions", () => {
  assert.match(app, /@StateObject private var voiceSession = VoiceSessionCoordinator\(\)/);
  assert.match(app, /RESLUWebView\(voiceSession: voiceSession\)/);
  assert.match(app, /scenePhase[\s\S]*appDidBecomeActive/);
  assert.match(app, /appDidEnterBackground/);
  assert.match(webView, /@ObservedObject var voiceSession: VoiceSessionCoordinator/);
  assert.match(webView, /didFinish navigation:[\s\S]*webDidFinishNavigation\(\)/);
  assert.doesNotMatch(app, /@ObservedObject private var voiceSession|RESLUWebView\(voiceSession: VoiceSessionCoordinator\(\)\)/);
});

test("the shell keeps canonical RESLU authentication, server SDP and production origin", () => {
  assert.match(webView, /https:\/\/spec\.reslu\.com\.au\/messages/);
  assert.match(webView, /websiteDataStore = \.default\(\)/);
  assert.match(webView, /url\.scheme == "https" && url\.host == trustedMediaHost/);
  assert.match(webView, /origin\.protocol == "https" && origin\.host == trustedMediaHost/);
  assert.match(webView, /nativeRealtimeTransport:true/);
  assert.match(voice, /websiteDataStore\.httpCookieStore/);
  assert.match(nativeHTTP, /\/api\/conversations\/\\\(conversationId\)\/realtime\/session/);
  assert.match(nativeHTTP, /X-RESLU-Agent/);
  assert.match(nativeHTTP, /"native_continuity": nativeContinuity/);
  assert.match(nativeHTTP, /maximumPendingCallEnds = 20/);
  assert.match(nativeHTTP, /flushPendingCallEnds/);
  assert.match(
    nativeHTTP,
    /func endCall\([\s\S]*queuePendingCallEnd\(entry\)[\s\S]*Task \{ \[weak self\]/,
    "CallKit hang-up must be durable before the first network suspension point",
  );
  assert.match(
    voice,
    /let nativeContinuity = continuity\.payload[\s\S]*realtimeHTTPClient\.endCall\([\s\S]*realtimeTransport\.stop\(\)/,
  );
  assert.match(voice, /NativeRealtimeUsageMetrics/);
  assert.match(voice, /realtimeUsage\.observe\(event\)/);
  assert.match(voice, /openai_realtime_response_done_client_observed/);
  assert.match(nativeHTTP, /body\["voice_metrics"\] = voiceMetrics/);
  assert.match(voice, /"turns": realtimeTransport\.voiceLatencyMetrics/);
  assert.match(nativeLatency, /maximumTurns = 20/);
  assert.match(nativeLatency, /speech_to_ack_ms/);
  assert.match(nativeLatency, /queue_wait_ms/);
  assert.match(nativeLatency, /agent_processing_ms/);
  assert.match(nativeLatency, /interruption_to_buffer_cleared_ms/);
  assert.doesNotMatch(nativeLatency, /"transcript"|"query"|"tool_call_id"|"response_id"/);
});

test("web and native exchange provider events while the browser path remains optional", () => {
  assert.match(bridge, /webkit\?\.messageHandlers\?\.resluVoice \?\? null/);
  assert.match(bridge, /prepareNativeVoiceSession/);
  assert.match(bridge, /prepareNativeRealtimeSession/);
  assert.match(bridge, /nativeRealtimeTransportAvailable/);
  assert.match(bridge, /NATIVE_AUDIO_ACTIVATION_TIMEOUT_MS = 5000/);
  assert.match(recovery, /!state\.visible && !state\.backgroundCapable/);
  assert.match(wakeLock, /wakeLock\.request\("screen"\)/);
  assert.match(workspace, /requestCallScreenWakeLock/);
  assert.match(workspace, /type: "call\.start"/);
  assert.match(workspace, /type: "call\.connected"/);
  assert.match(workspace, /type: "call\.end"/);
  assert.match(workspace, /reslu-native-voice/);
  assert.match(workspace, /detail\?\.type === "end-requested"/);
  assert.match(workspace, /detail\?\.type === "mute-requested"/);
  assert.match(workspace, /track\.enabled = !detail\.muted/);
  assert.match(workspace, /type: "call\.muted", muted: next/);
  assert.match(workspace, /type: "call\.audio-route", route: next \? "speaker" : "automatic"/);
  assert.match(workspace, /nativeAudioRouting && <button[\s\S]*Use speakerphone/);
  assert.match(workspace, /nativeRealtimeEventHandlerRef/);
  assert.match(workspace, /native_handled: true/);
  assert.match(workspace, /type: "web\.ready"/);
  assert.match(voice, /maximumPendingWebPayloads = 80/);
  assert.match(voice, /webDocumentReady/);
  assert.match(voice, /flushPendingWebPayloads/);
  assert.match(voice, /payload\["callId"\]/);
  assert.match(workspace, /detail\.callId !== callIdRef\.current/);
  assert.match(nativeTools, /\/realtime\/\\\(endpoint\)/);
  assert.match(nativeTools, /\/realtime\/task/);
  assert.match(nativeTools, /payload\["target_agent_slug"\]/);
  assert.match(nativeTools, /targetAgent == context\.agentSlug/);
  assert.match(nativeTools, /body\["target_agent_slug"\] = targetAgent/);
  assert.match(nativeTools, /cancelConsult\(toolCallId: activeConsult\.id/);
  assert.match(nativeTools, /guard !Task\.isCancelled, isActiveConsult\(toolCallId\)/);
  assert.match(nativeTools, /activeOutputAudioResponseId/);
  assert.match(nativeTools, /output_audio_buffer\.clear/);
  assert.match(nativeTools, /reslu_progress/);
  assert.match(nativeTools, /startProgressCue\(toolCallId:/);
  assert.match(nativeTools, /stopProgressCue\(\)/);
  assert.doesNotMatch(nativeTools, /checking that now/i);
  assert.match(nativeTools, /conversation\.item\.create/);
  assert.match(nativeTools, /response\.create/);
});

test("the post-install verifier generates and compiles an unsigned iPhone target", () => {
  assert.match(verifier, /prepare-ios-webrtc\.sh/);
  assert.match(verifier, /swiftc[\s\S]*-typecheck[\s\S]*arm64-apple-ios16\.0/);
  assert.match(prepareWebRTC, /151\.0\.0/);
  assert.match(prepareWebRTC, /64a218fad3d84a0d783321aa9a1eec58ca266ac7879123f86b0b44b703b7d8dc/);
  assert.match(prepareWebRTC, /--continue-at -/);
  assert.match(prepareWebRTC, /shasum -a 256/);
  assert.match(verifier, /xcodegen generate/);
  assert.match(verifier, /-sdk iphoneos/);
  assert.match(verifier, /generic\/platform=iOS/);
  assert.match(verifier, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(verifier, /mktemp -d \/tmp\/reslu-ios-derived-data/);
});
