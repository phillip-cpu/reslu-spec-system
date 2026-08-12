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
const bridge = read("lib/native-voice-bridge.ts");
const recovery = read("lib/realtime-call-recovery.ts");
const wakeLock = read("lib/call-screen-wake-lock.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const verifier = read("scripts/verify-ios-shell.sh");

test("the native target is an iPhone shell with explicit call background modes", () => {
  assert.match(project, /PRODUCT_BUNDLE_IDENTIFIER: au\.com\.reslu\.spec/);
  assert.match(project, /platform: iOS/);
  assert.match(info, /NSMicrophoneUsageDescription/);
  assert.match(info, /NSCameraUsageDescription/);
  assert.match(info, /UIBackgroundModes[\s\S]*<string>audio<\/string>[\s\S]*<string>voip<\/string>/);
});

test("native iOS owns audio policy and CallKit without duplicating RESLU agent logic", () => {
  assert.match(voice, /setCategory\([\s\S]*\.playAndRecord[\s\S]*mode: \.voiceChat/);
  assert.match(voice, /CXProvider/);
  assert.match(voice, /CXStartCallAction/);
  assert.match(voice, /CXEndCallAction/);
  assert.match(voice, /CXSetMutedCallAction/);
  assert.match(voice, /case "call\.muted"[\s\S]*setMutedFromWeb/);
  assert.match(voice, /mute-requested/);
  assert.match(voice, /mute-sync-error/);
  assert.match(voice, /reportOutgoingCall/);
  assert.match(voice, /didActivate audioSession:[\s\S]*native-audio-ready/);
  assert.doesNotMatch(voice, /perform action: CXStartCallAction[\s\S]*configureAudioSession\(activate: true\)/);
  assert.doesNotMatch(`${voice}\n${webView}`, /OPENAI_API_KEY|\/v1\/realtime|consult_reslu_agent|openclaw/i);
});

test("the CallKit coordinator survives SwiftUI scene and lock-screen transitions", () => {
  assert.match(app, /@StateObject private var voiceSession = VoiceSessionCoordinator\(\)/);
  assert.match(app, /RESLUWebView\(voiceSession: voiceSession\)/);
  assert.match(webView, /@ObservedObject var voiceSession: VoiceSessionCoordinator/);
  assert.doesNotMatch(app, /@ObservedObject private var voiceSession|RESLUWebView\(voiceSession: VoiceSessionCoordinator\(\)\)/);
});

test("the shell keeps canonical RESLU authentication and grants media only to production", () => {
  assert.match(webView, /https:\/\/spec\.reslu\.com\.au\/messages/);
  assert.match(webView, /websiteDataStore = \.default\(\)/);
  assert.match(webView, /url\.scheme == "https" && url\.host == trustedMediaHost/);
  assert.match(webView, /origin\.protocol == "https" && origin\.host == trustedMediaHost/);
});

test("web and native exchange lifecycle only while the browser path remains optional", () => {
  assert.match(bridge, /webkit\?\.messageHandlers\?\.resluVoice \?\? null/);
  assert.match(bridge, /prepareNativeVoiceSession/);
  assert.match(bridge, /native-audio-ready/);
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
});

test("the post-install verifier generates and compiles an unsigned simulator target", () => {
  assert.match(verifier, /xcodegen generate/);
  assert.match(verifier, /-sdk iphonesimulator/);
  assert.match(verifier, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(verifier, /mktemp -d \/tmp\/reslu-ios-derived-data/);
});
