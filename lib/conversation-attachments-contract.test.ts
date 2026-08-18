import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/092_conversation_attachments.sql");
const reliabilityMigration = read("supabase/migrations/093_conversation_message_reliability.sql");
const uploadUrlRoute = read("app/api/conversations/[id]/attachments/upload-url/route.ts");
const attachmentRoute = read("app/api/conversations/[id]/attachments/route.ts");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const fileSniff = read("lib/file-sniff.ts");
const uploadRecovery = read("lib/conversation-upload-recovery.ts");
const imageUpload = read("lib/conversation-image-upload.ts");

test("conversation attachments are private member-scoped canonical records", () => {
  assert.match(migration, /create table if not exists conversation_attachments/);
  assert.match(migration, /alter table conversation_attachments enable row level security/);
  assert.match(migration, /is_conversation_member\(conversation_id\)/);
  assert.match(migration, /message_id\s+uuid references conversation_messages\(id\) on delete cascade/);
  assert.match(migration, /byte_size between 1 and 26214400/);
  assert.match(reliabilityMigration, /message_id is not null or uploaded_by = auth\.uid\(\)/);
});

test("attachment messages bind ready staged rows atomically", () => {
  assert.match(migration, /create_conversation_message_with_attachments/);
  assert.match(migration, /attachment\.uploaded_by = auth\.uid\(\)/);
  assert.match(migration, /attachment\.status = 'ready'/);
  assert.match(reliabilityMigration, /create_conversation_message_idempotent/);
  assert.match(reliabilityMigration, /update conversation_attachments/);
  assert.match(messageRoute, /create_conversation_message_idempotent/);
  assert.match(messageRoute, /p_attachment_ids: attachmentIds/);
});

test("browser uploads directly to private storage and server verifies real bytes", () => {
  assert.match(uploadUrlRoute, /createSignedUploadUrl/);
  assert.match(workspace, /uploadToSignedUrl/);
  assert.match(attachmentRoute, /inspectStorageObjectHead/);
  assert.match(attachmentRoute, /inspection\.byteSize !== attachment\.byte_size/);
  assert.match(attachmentRoute, /could not be verified yet\. Please retry/);
  assert.match(fileSniff, /responsePrefix\(res, 16\)/);
  assert.match(fileSniff, /reader\.cancel/);
  assert.match(attachmentRoute, /actualKind !== EXPECTED_KIND/);
  assert.match(attachmentRoute, /createSignedUrl/);
});

test("message attachment links refresh privately instead of expiring in the thread", () => {
  assert.match(attachmentRoute, /export async function GET/);
  assert.match(attachmentRoute, /Cache-Control", "private, no-store/);
  assert.match(messageRoute, /conversationAttachmentAccessUrl/);
  assert.doesNotMatch(messageRoute, /createSignedUrls/);
});

test("modern composer exposes working camera and file entry points", () => {
  assert.match(workspace, /capture="environment"/);
  assert.match(workspace, /Photos or PDF/);
  assert.match(workspace, /draftAttachments/);
  assert.match(workspace, /attachmentIds: attachments\.map\(\(attachment\) => attachment\.id\)/);
  assert.match(workspace, /attachment_ids: entry\.attachmentIds/);
  assert.match(workspace, /message\.attachments\.map/);
  assert.match(workspace, /onDrop=/);
  assert.match(workspace, /Drop photos or PDFs here/);
  assert.match(workspace, /event\.clipboardData\.files/);
  assert.match(workspace, /normalizeConversationAttachmentMime/);
  assert.match(workspace, /new File\(\[draft\.file\]/);
});

test("attachment drafts cannot leak into another conversation mid-upload", () => {
  assert.match(workspace, /attachmentUploadInProgress/);
  assert.match(workspace, /cancelledDraftIdsRef/);
  assert.match(workspace, /Cancel upload of/);
  assert.match(workspace, /selectConversation\(conversation\.id\)/);
  assert.match(workspace, /selectConversation\(null\)/);
  assert.match(workspace, /const conversationId = selectedId/);
  assert.match(workspace, /item\.conversationId/);
  assert.match(workspace, /keepalive: true/);
  assert.match(workspace, /draftAttachmentsByConversationRef/);
  assert.match(workspace, /const current = draftAttachmentsByConversationRef\.current\.get\(conversationId\)/);
  assert.match(workspace, /selectedIdRef\.current === conversationId/);
  assert.match(workspace, /MAX_CONVERSATION_ATTACHMENTS - draftAttachmentsRef\.current\.length/);
});

test("ready and interrupted attachment drafts survive chat switches and reloads", () => {
  assert.match(attachmentRoute, /searchParams\.get\("drafts"\) === "1"/);
  assert.match(attachmentRoute, /\.is\("message_id", null\)/);
  assert.match(attachmentRoute, /attachment\.uploaded_by === userId/);
  assert.match(workspace, /loadServerDraftAttachments/);
  assert.match(workspace, /recoverStagedAttachment/);
  assert.match(workspace, /Ready, unbound server rows deliberately survive navigation\/reload/);
  assert.doesNotMatch(workspace, /useEffect\(\(\) => \(\) => \{[\s\S]{0,800}method: "DELETE"/);
});

test("a hung iPhone signed-upload response cannot block finalisation forever", () => {
  assert.match(workspace, /awaitConversationUploadReady/);
  assert.match(workspace, /probeConversationAttachment/);
  assert.match(attachmentRoute, /attachment\.status === "ready"/);
  assert.match(uploadRecovery, /Promise\.race\(\[uploadSettled, delay/);
  assert.match(uploadRecovery, /CONVERSATION_UPLOAD_MAX_PROBES/);
  assert.match(uploadRecovery, /recoverable/);
});

test("large phone photos are resized before their signed upload", () => {
  assert.match(workspace, /prepareConversationImageForUpload/);
  assert.match(workspace, /image\/heic,image\/heif,\.heic,\.heif/);
  assert.match(workspace, /mimeType: preparedMimeType/);
  assert.match(workspace, /Preparing/);
  assert.match(imageUpload, /CONVERSATION_IMAGE_OPTIMIZE_THRESHOLD_BYTES/);
  assert.match(imageUpload, /CONVERSATION_IMAGE_MAX_DIMENSION/);
  assert.match(imageUpload, /canvas\.toBlob/);
});

test("normal photos use one authenticated request through ready state", () => {
  assert.match(workspace, /CONVERSATION_DIRECT_UPLOAD_MAX_BYTES/);
  assert.match(workspace, /new FormData\(\)/);
  assert.match(workspace, /completedAttachment/);
  assert.match(attachmentRoute, /multipart\/form-data/);
  assert.match(attachmentRoute, /request\.formData\(\)/);
  assert.match(attachmentRoute, /\.upload\(storagePath, bytes/);
  assert.match(attachmentRoute, /status: "ready"/);
  assert.match(attachmentRoute, /retryable: true/);
});

test("failed uploads are explicit, retryable and cannot be silently omitted", () => {
  assert.match(workspace, /retryDraftAttachment/);
  assert.match(workspace, /Retry upload/);
  assert.match(workspace, /attachmentUploadFailed/);
  assert.match(workspace, /Retry or remove every failed attachment before sending/);
});

test("a later upload removes abandoned staged rows and private objects", () => {
  assert.match(uploadUrlRoute, /STAGED_CONVERSATION_ATTACHMENT_MAX_AGE_MS/);
  assert.match(uploadUrlRoute, /\.is\("message_id", null\)/);
  assert.match(uploadUrlRoute, /\.eq\("status", "uploading"\)/);
  assert.match(uploadUrlRoute, /remove\(stalePaths\)/);
});
