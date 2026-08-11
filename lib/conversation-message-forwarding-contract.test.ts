import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/107_conversation_message_forwarding.sql");
const verifier = read("supabase/fixtures/107_conversation_message_forwarding_verify.sql");
const forwardRoute = read("app/api/conversations/[id]/messages/[messageId]/forward/route.ts");
const attachmentRoute = read("app/api/conversations/[id]/attachments/route.ts");
const messagesRoute = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");

test("one client intent forwards atomically to one through ten unique member chats", () => {
  assert.match(migration, /cardinality\(p_destination_conversation_ids\)/i);
  assert.match(migration, /destination_count not between 1 and 10/i);
  assert.match(migration, /count\(distinct item\)/i);
  assert.match(migration, /hashtextextended\(auth\.uid\(\)::text \|\| ':message-forward:'/i);
  assert.match(migration, /client forward id was already used for a different request/i);
  assert.match(migration, /is_conversation_member\(p_source_conversation_id\)/i);
  assert.match(migration, /where not is_conversation_member\(requested\.destination_id\)/i);
  assert.match(forwardRoute, /destinations\.length > 10/);
  assert.match(forwardRoute, /p_client_forward_id: body\.client_forward_id/);
});

test("a retry returns the same target message and cannot duplicate the agent job", () => {
  assert.match(migration, /unique \(forwarded_by, client_forward_id, destination_conversation_id\)/i);
  assert.match(migration, /return query[\s\S]*audit\.forwarded_message_id, true/i);
  assert.match(migration, /insert into conversation_messages/i);
  assert.match(migration, /'target_agent_slugs', '\[\]'::jsonb/i);
  assert.match(verifier, /retry created duplicate forward audit rows/i);
  assert.match(verifier, /direct-agent destination was not enqueued exactly once/i);
});

test("private files are target-scoped snapshots without duplicating their unique storage row", () => {
  assert.match(migration, /create table if not exists conversation_forwarded_attachments/i);
  assert.match(migration, /source_attachment_id[\s\S]*references conversation_attachments\(id\) on delete set null/i);
  assert.match(migration, /unique \(message_id, storage_path\)/i);
  assert.match(migration, /members_read_forwarded_attachments[\s\S]*is_conversation_member\(conversation_id\)/i);
  assert.doesNotMatch(migration, /insert into conversation_attachments/i);
  assert.match(migration, /revoke all on table conversation_forwarded_attachments from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /grant select on table conversation_forwarded_attachments to authenticated/i);
  assert.match(verifier, /target members can read the original private storage path/i);
  assert.match(verifier, /private attachment was not shared as one bounded snapshot/i);
});

test("forwarded private files remain usable through source deletion and another forward", () => {
  assert.match(migration, /source_forwarded_attachment_id/i);
  assert.match(verifier, /forwarding an already-forwarded private attachment lost continuity/i);
  assert.match(verifier, /deleting the source broke the independent forwarded copy/i);
  assert.match(attachmentRoute, /forwarded_attachment_id/);
  assert.match(attachmentRoute, /accessibleForwardedAttachment/);
  assert.match(attachmentRoute, /participant\.id === userId[\s\S]*participant\.is_self === true/);
  assert.match(attachmentRoute, /createServiceRoleClient/);
  assert.match(attachmentRoute, /new NextResponse\(storedObject\.body/);
  assert.doesNotMatch(attachmentRoute.match(/if \(forwardedAttachmentId\)[\s\S]*?const attachment = await accessibleReadyAttachment/)?.[0] ?? "", /NextResponse\.redirect/);
  assert.match(attachmentRoute, /message && !message\.deleted_at \? attachment : null/);
  assert.match(messagesRoute, /conversationForwardedAttachmentAccessUrl/);
});

test("the modern message menu exposes a searchable multi-chat forwarding flow", () => {
  assert.match(workspace, /function ForwardMessageDialog/);
  assert.match(workspace, /aria-label="Forward message"/);
  assert.match(workspace, /placeholder="Search chats"/);
  assert.match(workspace, /Forward to \$\{selected\.length\} chat/);
  assert.match(workspace, /setForwardingMessage\(message\)/);
  assert.match(workspace, />Forwarded</);
});

test("Aria and Marco receive forwarded text and files through their canonical bridge", () => {
  assert.match(bridge, /forwarded_attachments:conversation_forwarded_attachments/);
  assert.match(bridge, /metadata\.get\("source"\) == "forward"/);
  assert.match(bridge, /\[Forwarded message\]/);
  assert.match(bridge, /forwarded_attachments = \[/);
  assert.match(bridge, /materialize_attachments\(rest, attachments/);
  assert.match(verifier, /RESLU_VERIFY_107_PASS/);
});
