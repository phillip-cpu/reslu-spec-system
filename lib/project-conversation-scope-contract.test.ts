import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/20260812215025_project_scoped_conversations.sql");
const sharedProjectChatMigration = read(
  "supabase/migrations/20260901112433_join_existing_scoped_conversation.sql"
);
const projectChatConflictRepair = read(
  "supabase/migrations/20260901113056_fix_scoped_conversation_participant_conflict.sql"
);
const scopedRoute = read("app/api/conversations/scoped/route.ts");
const conversationRoute = read("app/api/conversations/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");
const projectPage = read("app/(dashboard)/projects/[id]/messages/page.tsx");
const projectPanel = read("components/conversations/ProjectConversationWorkspace.tsx");
const bridge = read("scripts/conversation_agent_bridge.py");
const styles = read("app/globals.css");

test("project and lead conversations have a durable member-scoped boundary", () => {
  assert.match(migration, /create table conversation_contexts/);
  assert.match(migration, /scope_kind in \('project', 'lead'\)/);
  assert.match(migration, /conversation_contexts_project_purpose_unique/);
  assert.match(migration, /using \(\(select is_conversation_member\(conversation_id\)\)\)/);
  assert.match(migration, /revoke insert, update, delete on conversation_contexts from anon, authenticated/);
  assert.match(migration, /revoke all on function get_or_create_scoped_conversation[\s\S]*from public, anon/);
});

test("scoped creation deduplicates by project and purpose rather than participant list", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /scoped-conversation:/);
  assert.match(migration, /where context\.scope_kind = p_scope_kind/);
  assert.match(scopedRoute, /get_or_create_scoped_conversation/);
  assert.match(scopedRoute, /scope_kind/);
  assert.doesNotMatch(scopedRoute, /create_conversation_idempotent/);
});

test("an existing project conversation safely joins the visiting staff member", () => {
  assert.match(sharedProjectChatMigration, /if p_scope_kind = 'project' then/);
  assert.match(sharedProjectChatMigration, /insert into conversation_participants/);
  assert.match(
    projectChatConflictRepair,
    /values \(found_conversation_id, actor_id, 'member'\)[\s\S]*on conflict do nothing/
  );
  assert.doesNotMatch(
    projectChatConflictRepair,
    /on conflict \(conversation_id, profile_id\)/
  );
  assert.match(sharedProjectChatMigration, /return query select found_conversation_id, true/);
  assert.match(
    sharedProjectChatMigration,
    /elsif not is_conversation_member\(found_conversation_id\) then[\s\S]*conversation scope already exists/
  );
});

test("conversation inbox and project UI preserve and visibly constrain scope", () => {
  assert.match(conversationRoute, /\.from\("conversation_contexts"\)/);
  assert.match(conversationRoute, /scope_label_snapshot/);
  assert.match(projectPage, /ProjectConversationWorkspace/);
  assert.match(projectPanel, /purpose_key: "general"/);
  assert.match(workspace, /conversation\.context\?\.scope_kind === scope\.kind/);
  assert.match(workspace, /Start a focused project chat/);
  assert.match(workspace, /selectedConversation\.context\.scope_label/);
});

test("project chat opening is bounded, idempotent and recoverable on a poor network", () => {
  assert.match(projectPanel, /boundedFetch\("\/api\/conversations\/scoped"/);
  assert.match(projectPanel, /PROJECT_CONVERSATION_OPEN_TIMEOUT_MS = 15_000/);
  assert.match(projectPanel, /const clientConversationId = createIntentRef\.current\.id/);
  assert.match(projectPanel, /client_conversation_id: clientConversationId/);
  assert.match(projectPanel, /BoundedRequestTimeoutError/);
  assert.match(projectPanel, /window\.addEventListener\("online", retryWhenOnline/);
  assert.match(projectPanel, /setOpenAttempt\(\(attempt\) => attempt \+ 1\)/);
  assert.match(projectPanel, /role="alert"/);
  assert.match(projectPanel, /min-h-11[\s\S]*Try again/);
  assert.doesNotMatch(projectPanel, /void fetch\("\/api\/conversations\/scoped"/);
});

test("background work and agent turns inherit a bounded authoritative scope", () => {
  assert.match(migration, /trg_agent_tasks_inherit_conversation_scope/);
  assert.match(bridge, /def conversation_scope_context/);
  assert.match(bridge, /AUTHORITATIVE_CONVERSATION_SCOPE_JSON/);
  assert.match(bridge, /Do not silently import facts from another project/);
  assert.match(bridge, /"authoritative_scope": scope_context or \{\}/);
});

test("messaging typography has a readable phone-first floor", () => {
  assert.match(styles, /\.conversation-accessible \.text-body[\s\S]*font-size: 15px/);
  assert.match(styles, /\.conversation-accessible \.text-caption[\s\S]*font-size: 12px/);
  assert.match(styles, /\.conversation-accessible \.text-subhead[\s\S]*font-size: 16px/);
});
