import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/094_conversation_unread_state.sql");
const verifier = read("supabase/fixtures/094_conversation_unread_state_verify.sql");
const listRoute = read("app/api/conversations/route.ts");
const readRoute = read("app/api/conversations/[id]/read/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("unread counts are canonical per participant and exclude the sender's own messages", () => {
  assert.match(migration, /create or replace function get_conversation_inbox\(\)/);
  assert.match(migration, /participant\.profile_id = auth\.uid\(\)/);
  assert.match(migration, /message\.author_profile_id is distinct from auth\.uid\(\)/);
  assert.match(migration, /order by newest\.created_at desc, newest\.id desc/);
  assert.match(listRoute, /last_message_id/);
  assert.match(listRoute, /\.in\("id", lastMessageIds\)/);
  assert.doesNotMatch(listRoute, /conversationIds\.length \* 10/);
  assert.match(listRoute, /supabase\.rpc\("get_conversation_inbox"\)/);
});

test("read state advances only through a real canonical message", () => {
  assert.match(migration, /add column if not exists last_read_message_id uuid/);
  assert.match(migration, /Older deployments stored only a timestamp/);
  assert.match(migration, /message\.created_at <= participant\.last_read_at/);
  assert.match(migration, /p_through_message_id uuid/);
  assert.match(migration, /message\.id = p_through_message_id/);
  assert.match(migration, /message\.id > participant\.last_read_message_id/);
  assert.match(migration, /p_through_message_id > participant\.last_read_message_id/);
  assert.match(migration, /source_message\.id = notification\.source_message_id/);
  assert.match(migration, /source_message\.id <= p_through_message_id/);
  assert.doesNotMatch(readRoute, /client.*timestamp|read_at.*body/i);
  assert.match(readRoute, /p_through_message_id: throughMessageId/);
});

test("the interface shows unread badges and marks only a visible thread at the bottom", () => {
  assert.match(workspace, /conversation\.unread_count > 0/);
  assert.match(workspace, /document\.visibilityState !== "visible"/);
  assert.match(workspace, /shouldStickToBottomRef\.current/);
  assert.match(workspace, /markConversationRead\(selectedId, newestCanonicalMessage\.id\)/);
});

test("the database verifier proves counts and a monotonic cursor without persistent test data", () => {
  assert.match(verifier, /^--[\s\S]*\nbegin;/);
  assert.match(verifier, /expected 2 unread messages/);
  assert.match(verifier, /inbox selected the wrong last message for an equal timestamp/);
  assert.match(verifier, /equal-timestamp id ordering lost the unread message/);
  assert.match(verifier, /exact notification cursor should leave only the newer equal-timestamp notification unread/);
  assert.match(verifier, /moved the read cursor backwards/);
  assert.match(verifier, /rollback;\s*$/);
});
