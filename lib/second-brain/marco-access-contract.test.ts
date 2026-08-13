import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");
const mcp = readFileSync(resolve(root, "mcp/src/index.mjs"), "utf8");
const notesRoute = readFileSync(resolve(root, "app/api/second-brain/notes/route.ts"), "utf8");
const reindexRoute = readFileSync(resolve(root, "app/api/second-brain/reindex/route.ts"), "utf8");
const migration = readFileSync(resolve(root, "supabase/migrations/20260813020124_link_marco_agent_profile.sql"), "utf8");

test("Marco MCP exposes curated memory plus bounded RESLU delegation", () => {
  assert.match(mcp, /const MARCO_ALLOWED_TOOLS = new Set\(\[\s*"delegate_reslu_agent_task",\s*"search",\s*"add_brain_note",\s*"index_rebuild"/);
  assert.match(mcp, /This creates background work only; it never bypasses approval/);
  assert.match(mcp, /AGENT_ROLE === "marco"[\s\S]*source: "marco"/);
  assert.match(mcp, /Marco may only search curated Second Brain memory/);
  assert.match(mcp, /Marco may only reindex Second Brain memory/);
});

test("Marco API writes are identity-bound and use stable workspace provenance", () => {
  assert.match(notesRoute, /MARCO_EMAIL/);
  assert.match(notesRoute, /source !== "marco"/);
  assert.match(notesRoute, /marco:\/\/workspace\//);
  assert.match(notesRoute, /lookup = lookup\.eq\("created_by", userInfo\.userId\)/);
  assert.match(notesRoute, /update = update\.eq\("created_by", userInfo\.userId\)/);
  assert.match(reindexRoute, /authenticatedEmail === MARCO_EMAIL && entityTypeFilter !== "memory"/);
});

test("Marco profile linkage is narrow and does not grant admin", () => {
  assert.match(migration, /lower\(new\.email\) = 'marco@reslu\.com\.au'/);
  assert.match(migration, /where slug = 'marco'/);
  assert.doesNotMatch(migration, /role\s*=\s*'admin'/i);
  assert.match(migration, /revoke all on function public\.link_marco_agent_profile\(\) from public/);
});
