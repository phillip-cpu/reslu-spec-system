import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/105_conversation_message_edit_delete.sql");
const verifier = read("supabase/fixtures/105_conversation_message_edit_delete_verify.sql");
const messagesRoute = read("app/api/conversations/[id]/messages/route.ts");
const actionRoute = read("app/api/conversations/[id]/messages/[messageId]/route.ts");
const attachmentRoute = read("app/api/conversations/[id]/attachments/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("message edits are owned, bounded, conflict-safe and do not re-enqueue agents", () => {
  assert.match(migration, /message\.author_profile_id = auth\.uid\(\)/i);
  assert.match(migration, /not is_conversation_member\(p_conversation_id\)/i);
  assert.match(migration, /created_at \+ interval '15 minutes'/i);
  assert.match(migration, /coalesce\(message_row\.edited_at, message_row\.created_at\) is distinct from p_expected_version/i);
  assert.match(migration, /greatest\([\s\S]*clock_timestamp\(\)[\s\S]*interval '1 microsecond'/i);
  const editFunction = migration.match(/create or replace function edit_conversation_message[\s\S]*?\n\$\$;/i)?.[0] ?? "";
  assert.doesNotMatch(editFunction, /agent_conversation_jobs|enqueue/i);
  assert.match(actionRoute, /p_expected_version: body\.expected_version/);
});

test("delete replaces shared content and retains a private author-only 30-day recovery copy", () => {
  assert.match(migration, /create table if not exists conversation_message_recoveries/i);
  assert.match(migration, /expires_at[\s\S]*interval '30 days'/i);
  assert.match(migration, /authors_read_message_recoveries[\s\S]*author_profile_id = auth\.uid\(\) and expires_at > now\(\)/i);
  assert.match(migration, /body = 'This message was deleted\.'/i);
  assert.match(migration, /existing tombstoned row[\s\S]*update conversation_messages message[\s\S]*message\.deleted_at is not null/i);
  assert.match(migration, /update agent_conversation_jobs job[\s\S]*triggering_message_id = message_row\.id/i);
  assert.doesNotMatch(migration, /update\s+agent_tasks/i);
  assert.match(migration, /purge_expired_conversation_message_recoveries[\s\S]*to service_role/i);
});

test("deleted messages remain as tombstones but their attachments cannot be reopened", () => {
  assert.doesNotMatch(messagesRoute.match(/export async function GET[\s\S]*?export async function POST/)?.[0] ?? "", /is\("deleted_at", null\)/);
  assert.match(attachmentRoute, /select\("deleted_at"\)[\s\S]*!message\.deleted_at \? attachment : null/i);
  assert.match(workspace, /message\.deleted_at && "italic opacity-60"/);
  assert.match(workspace, /deleteMessageRecoverably/);
  assert.match(workspace, /restoreMessage/);
  assert.match(workspace, />Edited</);
});

test("restore is explicit history recovery and never silently re-runs an agent turn", () => {
  assert.match(migration, /restore_conversation_message/i);
  assert.match(migration, /Restore is a history operation, not a new send/i);
  assert.match(verifier, /restore silently reactivated the cancelled agent reply/i);
  assert.match(verifier, /stale edit overwrote the canonical message/i);
  assert.match(verifier, /RESLU_VERIFY_105_PASS/);
});
