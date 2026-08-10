import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/092_conversation_attachments.sql");
const uploadUrlRoute = read("app/api/conversations/[id]/attachments/upload-url/route.ts");
const attachmentRoute = read("app/api/conversations/[id]/attachments/route.ts");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("conversation attachments are private member-scoped canonical records", () => {
  assert.match(migration, /create table if not exists conversation_attachments/);
  assert.match(migration, /alter table conversation_attachments enable row level security/);
  assert.match(migration, /is_conversation_member\(conversation_id\)/);
  assert.match(migration, /message_id\s+uuid references conversation_messages\(id\) on delete cascade/);
  assert.match(migration, /byte_size between 1 and 26214400/);
});

test("attachment messages bind ready staged rows atomically", () => {
  assert.match(migration, /create_conversation_message_with_attachments/);
  assert.match(migration, /attachment\.uploaded_by = auth\.uid\(\)/);
  assert.match(migration, /attachment\.status = 'ready'/);
  assert.match(messageRoute, /create_conversation_message_with_attachments/);
  assert.match(messageRoute, /p_attachment_ids: attachmentIds/);
});

test("browser uploads directly to private storage and server verifies real bytes", () => {
  assert.match(uploadUrlRoute, /createSignedUploadUrl/);
  assert.match(workspace, /uploadToSignedUrl/);
  assert.match(attachmentRoute, /sniffStorageObjectHead/);
  assert.match(attachmentRoute, /actualKind !== EXPECTED_KIND/);
  assert.match(attachmentRoute, /createSignedUrl/);
});

test("modern composer exposes working camera and file entry points", () => {
  assert.match(workspace, /capture="environment"/);
  assert.match(workspace, /Photos or PDF/);
  assert.match(workspace, /draftAttachments/);
  assert.match(workspace, /attachment_ids: attachmentIds/);
  assert.match(workspace, /message\.attachments\.map/);
});

test("attachment drafts cannot leak into another conversation mid-upload", () => {
  assert.match(workspace, /attachmentUploadInProgress/);
  assert.match(workspace, /Wait for the attachments to finish uploading before changing chats/);
  assert.match(workspace, /selectConversation\(conversation\.id\)/);
  assert.match(workspace, /selectConversation\(null\)/);
});
