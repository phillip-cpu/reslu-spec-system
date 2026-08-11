import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const route = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("active agent work is member-scoped and contains status rather than message content", () => {
  assert.match(route, /conversationParticipants\(supabase, id, user\.id\)/);
  assert.match(route, /\.from\("agent_conversation_jobs"\)[\s\S]*\.eq\("conversation_id", conversationId\)/);
  assert.match(route, /\.select\("agent_id,status,created_at,claimed_at"\)/);
  assert.match(route, /\.in\("status", \["pending", "processing"\]\)/);
});

test("the current thread shows truthful queued and processing feedback", () => {
  assert.match(workspace, /setAgentActivity/);
  assert.match(workspace, /activity\.status === "processing"/);
  assert.match(workspace, /Working on your request/);
  assert.match(workspace, /Waiting to start/);
  assert.match(workspace, /role="status" aria-live="polite"/);
  assert.match(workspace, /!historyAnchorMessageId && agentActivity\.map/);
});
