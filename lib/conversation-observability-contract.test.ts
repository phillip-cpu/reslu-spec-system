import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const health = read("lib/health.ts");
const card = read("components/health/SpecHealthCard.tsx");
const check = read("app/api/health/check/route.ts");

test("health inspects modern conversation queues, tasks, calls and bounded timing", () => {
  assert.match(health, /from\("agent_conversation_jobs"\)/);
  assert.match(health, /from\("agent_tasks"\)/);
  assert.match(health, /from\("conversation_calls"\)/);
  assert.match(health, /select\("realtime_voice_latency:metadata->realtime_voice_latency"\)/);
  assert.match(health, /\.limit\(50\)/);
  assert.match(health, /summarizeConversationVoiceHealth/);
  assert.match(card, /Aria &amp; Marco conversations/);
  assert.match(card, /Average acknowledgement/);
  assert.match(card, /Slowest interruption clear/);
});

test("conversation incidents are deduped and contain no private content", () => {
  assert.match(check, /conversationKind = "conversation_transport"/);
  assert.match(check, /notifyAdminsOnce\([\s\S]*conversationKind/);
  assert.match(check, /resolveOpenIncident\(conversationKind\)/);
  assert.doesNotMatch(health, /select\("(?:body|summary|objective|error|transcript|prompt|tool_arguments)/);
  assert.doesNotMatch(card, /transcript\}/);
  assert.match(card, /No transcript, prompt, file, tool argument or provider identifier/);
});
