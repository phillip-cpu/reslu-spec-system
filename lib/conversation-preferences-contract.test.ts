import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");
const migration = read("supabase/migrations/096_conversation_preferences.sql");
const verifier = read("supabase/fixtures/096_conversation_preferences_verify.sql");
const route = read("app/api/conversations/[id]/preferences/route.ts");
const listRoute = read("app/api/conversations/route.ts");
const workspace = read("components/conversations/ConversationWorkspace.tsx");

test("mute, pin and archive belong to the signed-in participant, never the shared conversation", () => {
  assert.match(migration, /alter table conversation_participants/);
  assert.match(migration, /participant\.profile_id = auth\.uid\(\)/);
  assert.match(migration, /raise exception 'unauthorized'/);
  assert.doesNotMatch(route, /from\("conversations"\)[\s\S]*update/);
  assert.match(route, /update_conversation_preferences/);
});

test("pinning unarchives and archiving unpins", () => {
  assert.match(migration, /when p_pinned is true then null/);
  assert.match(migration, /when p_archived is true then null/);
  assert.match(migration, /cannot be archived and pinned at the same time/);
  assert.match(verifier, /archiving did not unpin/);
  assert.match(verifier, /one request archived and pinned the same conversation/);
});

test("the inbox exposes active and archived views with mute and pin controls", () => {
  assert.match(listRoute, /archived_at: inbox\.get/);
  assert.match(listRoute, /pinned_at: inbox\.get/);
  assert.match(workspace, /No archived conversations/);
  assert.match(workspace, /Mute notifications/);
  assert.match(workspace, /Pin conversation/);
  assert.match(workspace, /Archive conversation/);
});

test("mobile Back remains on the conversation list after polling refreshes", () => {
  assert.match(workspace, /hasInitialConversationSelectionRef/);
  assert.match(workspace, /hasInitialConversationSelectionRef\.current\s*\?\s*null/);
  assert.match(workspace, /selectConversation\(null\)/);
});

test("the database verifier exercises real participant preferences and rolls back", () => {
  assert.match(verifier, /do \$verify\$/);
  assert.match(verifier, /has_function_privilege\(\s*'anon'/);
  assert.match(verifier, /PASS: mute, pin and archive/);
  assert.match(verifier, /when sqlstate 'P5096'/);
  assert.doesNotMatch(verifier, /create temporary table/);
});
