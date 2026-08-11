import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/108_conversation_group_management.sql");
const verifier = read("supabase/fixtures/108_conversation_group_management_verify.sql");
const groupRoute = read("app/api/conversations/[id]/group/route.ts");
const conversationRoute = read("app/api/conversations/route.ts");
const access = read("lib/conversation-access.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("group shared state is admin-RPC only and the creator starts as an admin", () => {
  assert.match(migration, /participant_role in \('member', 'admin'\)/i);
  assert.match(migration, /assign_conversation_creator_admin/i);
  assert.match(migration, /conversation\.created_by = new\.profile_id[\s\S]*new\.participant_role := 'admin'/i);
  assert.match(migration, /drop policy if exists "members_update_conversations"/i);
  assert.match(migration, /drop policy if exists "creators_add_participants"/i);
  assert.match(migration, /revoke update on table conversations from authenticated/i);
  assert.match(migration, /revoke insert, update, delete on table conversation_participants from authenticated/i);
  assert.match(verifier, /broad direct group writes still bypass/i);
});

test("admins can exactly-once rename and add bounded valid people or existing agents", () => {
  assert.match(migration, /create table if not exists conversation_group_actions/i);
  assert.match(migration, /unique \(actor_profile_id, client_action_id\)/i);
  assert.match(migration, /client group action id was already used for a different request/i);
  assert.match(migration, /alter table conversation_group_actions enable row level security/i);
  assert.match(migration, /revoke all on table conversation_group_actions from public, anon, authenticated/i);
  assert.match(migration, /create or replace function rename_conversation_group/i);
  assert.match(migration, /create or replace function add_conversation_group_participants/i);
  assert.match(migration, /is_conversation_admin\(p_conversation_id\)/i);
  assert.match(migration, /:group-management/i);
  assert.match(migration, /current_count \+ new_count > 50/i);
  assert.match(migration, /on conflict \(conversation_id, profile_id\) where profile_id is not null do nothing/i);
  assert.match(migration, /on conflict \(conversation_id, agent_id\) where agent_id is not null do nothing/i);
  assert.match(groupRoute, /body\.action === "rename"/);
  assert.match(groupRoute, /body\.action === "add"/);
  assert.match(groupRoute, /valid client action ID is required/i);
  assert.match(groupRoute, /p_client_action_id: body\.client_action_id/g);
  assert.match(workspace, /actionIntentRef/);
  assert.match(workspace, /client_action_id: actionIntentRef\.current\.id/);
  assert.match(verifier, /add retry did not return its original result/i);
  assert.match(verifier, /rename retry duplicated canonical history/i);
  assert.match(verifier, /successful group actions were not recorded exactly once/i);
});

test("a group always retains a human admin and leaving revokes access atomically", () => {
  assert.match(migration, /create or replace function set_conversation_group_admin/i);
  assert.match(migration, /a group must keep at least one admin/i);
  assert.match(migration, /create or replace function leave_conversation_group/i);
  assert.match(migration, /other_admin_count = 0[\s\S]*set participant_role = 'admin'/i);
  assert.match(migration, /delete from conversation_participants participant[\s\S]*participant\.profile_id = auth\.uid\(\)/i);
  assert.match(migration, /delete from notifications notification[\s\S]*notification\.user_id = auth\.uid\(\)/i);
  assert.match(verifier, /only group admin could demote themselves/i);
  assert.match(verifier, /group did not retain a human admin/i);
  assert.match(verifier, /former member retained a private notification preview/i);
  assert.match(verifier, /leave retry failed after access had already ended/i);
});

test("removing Aria or Marco stops only their unfinished work in that group", () => {
  assert.match(migration, /update agent_conversation_jobs job[\s\S]*job\.agent_id = target_agent_id[\s\S]*pending', 'processing'/i);
  assert.match(migration, /update agent_tasks task[\s\S]*task\.owner_agent_id = target_agent_id/i);
  assert.match(migration, /cancellation_requested_at = coalesce/i);
  assert.match(migration, /Agent removed from conversation/i);
  assert.doesNotMatch(migration, /delete from agent_tasks/i);
  assert.match(verifier, /removed agent conversational work kept running/i);
  assert.match(verifier, /removed agent background work kept running/i);
  assert.match(verifier, /remove retry failed after access had already ended/i);
});

test("every group mutation leaves truthful canonical system history", () => {
  assert.match(migration, /append_conversation_group_system_message/i);
  assert.match(migration, /'system'/i);
  assert.match(migration, /'group_action', 'rename'/i);
  assert.match(migration, /'group_action', 'add_participants'/i);
  assert.match(migration, /'group_action', 'remove_participant'/i);
  assert.match(migration, /'group_action', 'leave'/i);
  assert.match(workspace, /message\.kind === "system"/);
  assert.match(workspace, /Group update/);
  assert.match(verifier, /truthful canonical system history/i);
});

test("mobile and desktop expose one accessible group-details surface", () => {
  assert.match(workspace, /function GroupDetailsDialog/);
  assert.match(workspace, /aria-label="Group details"/);
  assert.match(workspace, />Group details</);
  assert.match(workspace, /New members can read the existing RESLU group history/);
  assert.match(workspace, /Make admin/);
  assert.match(workspace, /Remove admin/);
  assert.match(workspace, /Leave group/);
  assert.match(groupRoute, /body\.action === "role"/);
  assert.match(groupRoute, /body\.action === "remove"/);
  assert.match(groupRoute, /body\.action === "leave"/);
});

test("participant admin state is hydrated consistently in inbox and live thread", () => {
  assert.match(conversationRoute, /participant_role/);
  assert.match(conversationRoute, /is_admin: link\.participant_role === "admin"/);
  assert.match(access, /participant_role/);
  assert.match(access, /is_admin: row\.participant_role === "admin"/);
  assert.match(workspace, /const canManage = Boolean\(self\?\.is_admin\)/);
  assert.match(verifier, /RESLU_VERIFY_108_PASS/);
});
