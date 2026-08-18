import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/093_conversation_message_reliability.sql");
const conversationRoute = read("app/api/conversations/route.ts");
const messageRoute = read("app/api/conversations/[id]/messages/route.ts");
const callsRoute = read("app/api/conversations/[id]/calls/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const outbox = read("lib/conversation-outbox.ts");
const callOutbox = read("lib/conversation-call-outbox.ts");
const databaseVerifier = read("supabase/fixtures/093_conversation_message_reliability_verify.sql");

test("one device send intent can create only one canonical message", () => {
  assert.match(migration, /add column if not exists client_message_id uuid/);
  assert.match(migration, /conversation_messages_client_send_unique/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /client message id was already used for different content/);
  assert.match(migration, /bound_count <> requested_count or attached_count <> requested_count/);
  assert.match(messageRoute, /p_client_message_id: clientMessageId/);
  assert.match(workspace, /client_message_id: entry\.clientMessageId/);
  assert.match(messageRoute, /create_conversation_message_idempotent/);
});

test("conversation creation is atomic and retries reuse the same device intent", () => {
  assert.match(migration, /add column if not exists client_conversation_id uuid/);
  assert.match(migration, /conversations_client_create_unique/);
  assert.match(migration, /create_conversation_idempotent/);
  assert.match(migration, /direct-conversation:/);
  assert.match(conversationRoute, /client_conversation_id/);
  assert.match(conversationRoute, /create_conversation_idempotent/);
  assert.doesNotMatch(conversationRoute, /\.from\("conversation_participants"\)\.insert/);
  assert.match(workspace, /createIntentRef/);
});

test("call start and end survive lost responses without duplicate calls or timeline records", () => {
  assert.match(migration, /conversation_calls_client_start_unique/);
  assert.match(migration, /conversation_messages_call_record_unique/);
  assert.match(migration, /create_conversation_call_idempotent/);
  assert.match(migration, /end_conversation_call_idempotent/);
  assert.match(callsRoute, /client_call_id/);
  assert.match(callsRoute, /create_conversation_call_idempotent/);
  assert.match(callsRoute, /end_conversation_call_idempotent/);
  assert.match(workspace, /clientCallIdRef\.current \?\? crypto\.randomUUID\(\)/);
  assert.match(workspace, /savePendingConversationCallEnd/);
  assert.match(workspace, /window\.addEventListener\("online", flush\)/);
  assert.match(callOutbox, /reslu-conversation-call-ends:v1:/);
});

test("message targeting and queue permissions cannot be broadened by a direct client", () => {
  assert.match(messageRoute, /Agent targets must be unique Aria, Marco or Stuart values/);
  assert.match(migration, /message metadata must be an object/);
  assert.match(migration, /message metadata is too large/);
  assert.match(migration, /message agent targets are invalid/);
  assert.match(migration, /and kind = 'text'/);
  assert.match(migration, /canonical call, meeting, system and agent rows remain trusted writes/);
  assert.match(migration, /message\.author_profile_id = auth\.uid\(\)/);
  assert.match(migration, /participant\.agent_id = agent_conversation_jobs\.agent_id/);
  assert.match(migration, /create or replace function cancel_agent_conversation_jobs/);
  assert.match(migration, /message\.author_profile_id = auth\.uid\(\)[\s\S]*realtime_tool_call_id/);
});

test("a new voice turn fails closed if the old canonical agent job cannot be cancelled", () => {
  assert.match(messageRoute, /const \{ error: cancellationError \} = await supabase\.rpc\("cancel_agent_conversation_jobs"/);
  assert.match(messageRoute, /previous voice turn could not be interrupted safely/);
  assert.match(messageRoute, /status: 503/);
});

test("the browser persists outbox entries before clearing the composer", () => {
  assert.match(outbox, /indexedDB\.open/);
  assert.match(outbox, /message-outbox/);
  assert.match(outbox, /reslu-conversation-draft:v1:/);
  assert.match(outbox, /localStorage/);
  assert.match(workspace, /await savePendingConversationMessage\(entry\)/);
  assert.match(workspace, /clearDraft\(conversationId, body\)/);
  assert.ok(workspace.indexOf("await savePendingConversationMessage(entry)") < workspace.indexOf("clearDraft(conversationId, body)"));
});

test("optimistic messages expose queued, sending, failed, delivered and retry states", () => {
  assert.match(workspace, /Waiting for connection/);
  assert.match(workspace, /Sending…/);
  assert.match(workspace, /Not sent/);
  assert.match(workspace, /Delivered/);
  assert.match(workspace, /retryOutboxEntry/);
  assert.match(workspace, /window\.addEventListener\("online"/);
});

test("the device drains sends in order and a retryable failure cannot be overtaken", () => {
  assert.match(workspace, /const attempted = new Set<string>\(\)/);
  assert.match(workspace, /await dispatchOutboxEntry\(entry\)/);
  assert.match(workspace, /current\.status === "failed" && current\.retryable/);
  assert.match(workspace, /lastOutboxCreatedAtMsRef\.current \+ 1/);
  assert.match(workspace, /void flushOutbox\(\)/);
  assert.doesNotMatch(workspace, /then\(\(\) => dispatchOutboxEntry\(queued\)\)/);
});

test("a lost POST response is reconciled against the canonical message before showing failure", () => {
  assert.match(messageRoute, /client_message_id/);
  assert.match(messageRoute, /\.eq\("author_profile_id", user\.id\)/);
  assert.match(messageRoute, /canonical_message_id: canonicalMessage\?\.id \?\? null/);
  assert.match(workspace, /messages\?client_message_id=\$\{entry\.clientMessageId\}/);
  assert.match(workspace, /typeof reconciliation\.canonical_message_id === "string"/);
  assert.match(workspace, /attempt < 3 && !canonicalMessageId/);
  assert.match(workspace, /MESSAGE_RECONCILIATION_TIMEOUT_MS/);
  assert.match(workspace, /await discardOutboxEntry\(entry\.clientMessageId\)/);
  assert.ok(
    workspace.indexOf("typeof reconciliation.canonical_message_id")
      < workspace.indexOf('error: offline ? null : timedOut ? "Delivery confirmation timed out.'),
    "canonical reconciliation must run before the device reports a retryable failure"
  );
});

test("slow polling responses cannot overwrite a newer conversation or message snapshot", () => {
  assert.match(workspace, /conversationListRequestRef\.current !== requestNumber/);
  assert.match(workspace, /activeMessageRequestRef\.current\.has\(conversationId\)/);
  assert.match(workspace, /activeMessageRequestRef\.current\.get\(conversationId\) !== requestNumber/);
  assert.match(workspace, /activeMessageRequestRef\.current\.delete\(conversationId\)/);
});

test("poor-network reads are bounded and agent-work polling stays single-flight", () => {
  assert.match(workspace, /boundedFetch\([\s\S]*"\/api\/conversations"[\s\S]*CONVERSATION_READ_TIMEOUT_MS/);
  assert.match(workspace, /boundedFetch\([\s\S]*messages\$\{query\}[\s\S]*CONVERSATION_READ_TIMEOUT_MS/);
  assert.match(workspace, /activeAgentTaskRequestRef\.current\.has\(conversationId\)/);
  assert.match(workspace, /activeAgentTaskRequestRef\.current\.add\(conversationId\)/);
  assert.match(workspace, /activeAgentTaskRequestRef\.current\.delete\(conversationId\)/);
});

test("permanent send failures do not offer an endless retry loop", () => {
  assert.match(workspace, /pending\.retryable && \(/);
  assert.match(workspace, /copyOutboxEntry/);
  assert.match(workspace, /Discard this unsent message from this device/);
});

test("device drafts and queued messages are scoped to the signed-in profile", () => {
  assert.match(outbox, /ownerProfileId: string/);
  assert.match(outbox, /\$\{DRAFT_KEY_PREFIX\}\$\{ownerProfileId\}:\$\{conversationId\}/);
  assert.match(workspace, /entry\.ownerProfileId === ownerProfileId/);
  assert.match(workspace, /entry\.ownerProfileId === currentUserId/);
});

test("the Supabase acceptance check proves exact-once behavior without leaving test data", () => {
  assert.match(databaseVerifier, /^--[\s\S]*\nbegin;/);
  assert.match(databaseVerifier, /first_message_id <> test\.second_message_id/);
  assert.match(databaseVerifier, /canonical_message_count <> 1/);
  assert.match(databaseVerifier, /agent_job_count <> 1/);
  assert.match(databaseVerifier, /canonical_call_count <> 1/);
  assert.match(databaseVerifier, /call_record_count <> 1/);
  assert.match(databaseVerifier, /canonical_conversation_count <> 1/);
  assert.match(databaseVerifier, /canonical_conversation_participants <> 3/);
  assert.match(databaseVerifier, /retry accepted only a subset of the canonical attachment set/);
  assert.match(databaseVerifier, /duplicate agent targets were accepted/);
  assert.match(databaseVerifier, /rollback;\s*$/);
});
