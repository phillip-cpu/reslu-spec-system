import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/106_conversation_message_reactions_pins.sql");
const verifier = read("supabase/fixtures/106_conversation_message_reactions_pins_verify.sql");
const messagesRoute = read("app/api/conversations/[id]/messages/route.ts");
const reactionRoute = read("app/api/conversations/[id]/messages/[messageId]/reaction/route.ts");
const pinRoute = read("app/api/conversations/[id]/messages/[messageId]/pin/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("one member owns one bounded quick reaction per canonical message", () => {
  assert.match(migration, /primary key \(message_id, profile_id\)/i);
  assert.match(migration, /reaction in \('👍','❤️','😂','😮','😢','🙏'\)/i);
  assert.match(migration, /toggle_conversation_message_reaction/i);
  assert.match(migration, /message\.deleted_at is null\s+for update/i);
  assert.match(migration, /existing_reaction = p_reaction[\s\S]*delete from conversation_message_reactions/i);
  assert.match(migration, /on conflict \(message_id, profile_id\) do update/i);
  assert.match(reactionRoute, /isConversationMessageReaction/);
});

test("pins are shared, serialized and capped at five per conversation", () => {
  assert.match(migration, /hashtextextended\(p_conversation_id::text \|\| ':conversation-message-pins'/i);
  assert.match(migration, /pinned_count >= 5/i);
  assert.match(migration, /no more than five messages/i);
  assert.match(pinRoute, /set_conversation_message_pinned/);
  assert.match(messagesRoute, /pinnedConversationMessages/);
  assert.match(workspace, /aria-label="Pinned messages"/);
});

test("reaction and pin tables are member-readable but RPC-only for writes", () => {
  assert.match(migration, /members_read_message_reactions[\s\S]*is_conversation_member\(conversation_id\)/i);
  assert.match(migration, /members_read_message_pins[\s\S]*is_conversation_member\(conversation_id\)/i);
  assert.doesNotMatch(migration, /for (insert|update|delete) to authenticated/i);
  assert.match(migration, /grant execute on function toggle_conversation_message_reaction[\s\S]*to authenticated/i);
  assert.match(migration, /grant execute on function set_conversation_message_pinned[\s\S]*to authenticated/i);
});

test("deleting a message atomically clears its engagement and the verifier rolls back", () => {
  assert.match(migration, /after update of deleted_at on conversation_messages/i);
  assert.match(migration, /delete from conversation_message_reactions item where item\.message_id = new\.id/i);
  assert.match(migration, /delete from conversation_message_pins item where item\.message_id = new\.id/i);
  assert.match(verifier, /choosing another reaction did not replace the first/i);
  assert.match(verifier, /shared five-message pin limit was not enforced/i);
  assert.match(verifier, /RESLU_VERIFY_106_PASS/);
});

test("the mobile and desktop message menu exposes accessible reactions and pins", () => {
  assert.match(workspace, /CONVERSATION_MESSAGE_REACTIONS\.map/);
  assert.match(workspace, /aria-label=\{`React \$\{reaction\}`\}/);
  assert.match(workspace, /toggleMessageReaction/);
  assert.match(workspace, /toggleMessagePin/);
  assert.match(workspace, /reaction\.self_reacted/);
});
