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
  assert.match(health, /\.limit\(1000\)/);
  assert.match(health, /summarizeConversationVoiceHealth/);
  assert.match(health, /forward_conversation_message/);
  assert.match(health, /rename_conversation_group/);
  assert.match(card, /Unavailable messaging features/);
  assert.match(card, /RESLU agent conversations/);
  assert.match(card, /Average acknowledgement/);
  assert.match(card, /Slowest interruption clear/);
});

test("conversation incidents are deduped and contain no private content", () => {
  assert.match(check, /conversationKind = "conversation_transport"/);
  assert.match(check, /notifyAdminsOnce\([\s\S]*conversationKind/);
  assert.match(check, /resolveOpenIncident\(conversationKind\)/);
  assert.match(check, /unavailable messaging capabilities/);
  assert.doesNotMatch(health, /select\("(?:body|summary|objective|error|transcript|prompt|tool_arguments)/);
  assert.doesNotMatch(card, /transcript\}/);
  assert.match(card, /No transcript, prompt, reply, reasoning, file or tool argument is stored/);
});
