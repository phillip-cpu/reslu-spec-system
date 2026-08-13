import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/20260813074312_inter_agent_delegation.sql");
const route = read("app/api/conversations/[id]/delegations/route.ts");
const mcp = read("mcp/src/index.mjs");
const bridge = read("scripts/conversation_agent_bridge.py");
const guard = read("openclaw/plugins/reslu-conversation-guard/policy.mjs");

test("delegation is agent-authenticated, conversation-scoped and bounded", () => {
  assert.match(migration, /agent\.auth_profile_id = auth\.uid\(\)/i);
  assert.match(migration, /participant\.conversation_id = p_conversation_id[\s\S]*participant\.agent_id = v_caller\.id/i);
  assert.match(migration, /v_target\.slug not in \('aria', 'marco', 'stuart'\)/i);
  assert.match(migration, /source task delegation limit reached/i);
  assert.match(migration, /an agent cannot delegate work to itself/i);
  assert.match(migration, /delegation idempotency key conflict/i);
  assert.match(migration, /revoke all on function delegate_conversation_agent_task[\s\S]*from public, anon/i);
  assert.match(migration, /grant execute on function delegate_conversation_agent_task[\s\S]*to authenticated/i);
});

test("the MCP tool is a thin API adapter shared by Aria, Marco and Stuart", () => {
  assert.match(mcp, /name: "delegate_reslu_agent_task"/);
  assert.match(mcp, /target_agent: \{ type: "string", enum: \["aria", "marco", "stuart"\] \}/);
  assert.match(mcp, /apiFetch\(`\/api\/conversations\/\$\{encodeURIComponent\(conversation_id\)\}\/delegations`/);
  assert.match(mcp, /const STUART_ALLOWED_TOOLS = new Set\(\[[\s\S]*"delegate_reslu_agent_task"/);
  assert.match(route, /supabase\.rpc\("delegate_conversation_agent_task"/);
  assert.doesNotMatch(route, /createServiceRoleClient/);
});

test("direct chat allows only the guarded delegation boundary, not generic spawning", () => {
  assert.match(guard, /state\.mode === "human_request" && toolName\.endsWith\(DELEGATION_TOOL_SUFFIX\)/);
  assert.match(guard, /"sessions_spawn"/);
  assert.match(guard, /"sessions_send"/);
  assert.match(bridge, /TRUSTED_CONVERSATION_TRANSPORT_JSON/);
  assert.match(bridge, /use delegate_reslu_agent_task/i);
  assert.match(bridge, /Pass this task_id as source_task_id/i);
});

test("specialist work returns through the owning chat with explicit attribution", () => {
  assert.match(bridge, /task\.get\("delegated_by_agent_id"\) or task\["owner_agent_id"\]/);
  assert.match(bridge, /"delegated_agent_name": agent\["display_name"\]/);
  const workspace = read("components/conversations/ConversationWorkspace.tsx");
  assert.match(workspace, /Completed by \{message\.metadata\.delegated_agent_name\}/);
  assert.match(workspace, /task\.delegated_by_agent_id[\s\S]*task\.owner_agent\.display_name/);
});

test("the production verifier exercises idempotency and rolls back", () => {
  const verifier = read("supabase/fixtures/20260813074312_inter_agent_delegation_verify.sql");
  assert.match(verifier, /(?:^|\n)begin;/i);
  assert.match(verifier, /delegate_conversation_agent_task\(/i);
  assert.match(verifier, /specialist was silently added/i);
  assert.match(verifier, /idempotency retry created duplicate work/i);
  assert.match(verifier, /rollback;/i);
});
