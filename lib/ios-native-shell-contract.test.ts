import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const project = read("ios/RESLU/project.yml");
const info = read("ios/RESLU/RESLU/Info.plist");
const webView = read("ios/RESLU/RESLU/RESLUWebView.swift");
const voice = read("ios/RESLU/RESLU/VoiceSessionCoordinator.swift");
const bridge = read("lib/native-voice-bridge.ts");
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
  assert.match(voice, /reportOutgoingCall/);
  assert.doesNotMatch(`${voice}\n${webView}`, /OPENAI_API_KEY|\/v1\/realtime|consult_reslu_agent|openclaw/i);
});

test("the shell keeps canonical RESLU authentication and grants media only to production", () => {
  assert.match(webView, /https:\/\/spec\.reslu\.com\.au\/messages/);
  assert.match(webView, /websiteDataStore = \.default\(\)/);
  assert.match(webView, /origin\.host == trustedMediaHost \? \.grant : \.deny/);
});

test("web and native exchange lifecycle only while the browser path remains optional", () => {
  assert.match(bridge, /webkit\?\.messageHandlers\?\.resluVoice\?\.postMessage/);
  assert.match(workspace, /type: "call\.start"/);
  assert.match(workspace, /type: "call\.connected"/);
  assert.match(workspace, /type: "call\.end"/);
  assert.match(workspace, /reslu-native-voice/);
  assert.match(workspace, /detail\?\.type === "end-requested"/);
});

test("the post-install verifier generates and compiles an unsigned simulator target", () => {
  assert.match(verifier, /xcodegen generate/);
  assert.match(verifier, /-sdk iphonesimulator/);
  assert.match(verifier, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(verifier, /mktemp -d \/tmp\/reslu-ios-derived-data/);
});
