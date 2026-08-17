import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migration = readFileSync(resolve(root, "supabase/migrations/115_stuart_finance_agent.sql"), "utf8");
const evidenceKindMigration = readFileSync(resolve(root, "supabase/migrations/20260817220000_allow_stuart_missing_source_evidence.sql"), "utf8");
const mcp = readFileSync(resolve(root, "mcp/src/index.mjs"), "utf8");

test("Stuart becomes a first-class conversation agent without broad finance table access", () => {
  assert.match(migration, /slug in \('aria', 'marco', 'stuart'\)/);
  assert.match(migration, /'accounts@reslu\.com\.au'/);
  assert.match(migration, /jsonb_array_length\(p_metadata->''target_agent_slugs''\) > 3/);
  assert.match(migration, /revoke all on table stuart_finance_findings from public, anon, authenticated/);
  assert.match(migration, /grant all on table stuart_finance_findings to service_role/);
});

test("Stuart is structurally denied general MCP mutation tools", () => {
  assert.match(mcp, /const AGENT_ROLE = process\.env\.RESLU_AGENT_ROLE/);
  assert.match(mcp, /const STUART_ALLOWED_TOOLS = new Set/);
  assert.match(mcp, /"get_stuart_finance_brief"/);
  assert.match(mcp, /"get_stuart_invoice_evidence"/);
  assert.match(mcp, /"run_stuart_finance_review"/);
  assert.match(mcp, /TOOLS\.filter\(\(\{ name \}\) => toolAllowedForAgent\(name\)\)/);
  assert.match(mcp, /if \(!tool \|\| !toolAllowedForAgent\(name\)\)/);
});

test("incorrect Aria forwards enter her existing durable queue", () => {
  assert.match(migration, /'finance_routing_feedback'/);
  assert.match(migration, /stuart_aria_feedback/);
});

test("the database accepts Stuart's missing-source-evidence classification", () => {
  assert.match(evidenceKindMigration, /drop constraint if exists stuart_finance_findings_kind_check/);
  assert.match(evidenceKindMigration, /'missing_source_evidence'/);
  assert.match(evidenceKindMigration, /add constraint stuart_finance_findings_kind_check check/);
});
