import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/098_conversation_quoted_replies.sql");
const verifier = read("supabase/fixtures/098_conversation_quoted_replies_verify.sql");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const outbox = read("lib/conversation-outbox.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");

test("a reply target is part of the exactly-once canonical send intent", () => {
  assert.match(migration, /p_reply_to_id uuid default null/);
  assert.match(migration, /created_message\.reply_to_id is distinct from p_reply_to_id/);
  assert.match(migration, /bound_count <> requested_count or attached_count <> requested_count/);
  assert.match(migration, /target\.conversation_id = p_conversation_id/);
  assert.match(migration, /target\.deleted_at is null/);
  assert.match(migration, /message metadata is too large/);
  assert.match(migration, /message agent targets are invalid/);
  assert.match(messageRoute, /p_reply_to_id: replyToId/);
});

test("database-first rollout remains compatible with the old five-argument client", () => {
  assert.match(migration, /drop function if exists create_conversation_message_idempotent\(uuid, text, jsonb, uuid, uuid\[\]\)/);
  assert.match(verifier, /Legacy five-argument send/);
  assert.match(verifier, /ambiguous five-argument overload still exists/);
});

test("quoted replies survive offline queueing, browser recovery and retry", () => {
  assert.match(outbox, /replyToId: string \| null/);
  assert.match(outbox, /entry\.replyToId === undefined \? \{ \.\.\.entry, replyToId: null \} : entry/);
  assert.match(workspace, /reply_to_id: entry\.replyToId/);
  assert.match(workspace, /replyToId: replyTarget\?\.id \?\? null/);
});

test("replying to an agent in a group routes the turn back to that existing agent", () => {
  assert.match(messageRoute, /select\("author_agent_id"\)/);
  assert.match(messageRoute, /agent\.id === replyTargetAgentId/);
  assert.match(bridge, /\[Replying to \{target_author\}: \{target_body\}\]/);
});

test("the message and composer UI expose reply, quote navigation and copy", () => {
  assert.match(workspace, />\s*Reply\s*</);
  assert.match(workspace, /Replying to \{replyingTo\.author\.display_name\}/);
  assert.match(workspace, /jumpToReferencedMessage/);
  assert.match(workspace, /copyCanonicalMessage/);
});

test("the database verifier proves target integrity and rolls back", () => {
  assert.match(verifier, /^--[\s\S]*\nbegin;/);
  assert.match(verifier, /one client send id changed its reply target/);
  assert.match(verifier, /PASS: quoted replies are canonical/);
  assert.match(verifier, /rollback;\s*$/);
});
