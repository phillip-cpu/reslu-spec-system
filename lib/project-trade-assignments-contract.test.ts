import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260902121452_project_trade_assignments.sql"
);
const assignmentsRoute = read("app/api/projects/[id]/trade-assignments/route.ts");
const taskRoute = read("app/api/board-tasks/[id]/route.ts");
const boardRoute = read("app/api/projects/[id]/board/route.ts");
const sowBuilder = read("components/sow/SowBuilder.tsx");
const bookingPanel = read("components/board/GroupBookPanel.tsx");

test("one normalized project trade assignment is exposed safely to authenticated staff", () => {
  assert.match(migration, /unique \(project_id, role_key\)/);
  assert.match(migration, /role_key = lower\(btrim\(trade_role\)\)/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /to authenticated using \(true\) with check \(true\)/);
  assert.match(migration, /revoke all on table public\.project_trade_assignments[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete[\s\S]*to authenticated, service_role/);
  assert.match(migration, /revoke all on function public\.set_project_trade_assignment[\s\S]*from public, anon/);
  assert.match(migration, /from public\.contacts[\s\S]*deleted_at is null/);
  assert.match(assignmentsRoute, /\.is\("deleted_at", null\)/);
  assert.match(assignmentsRoute, /supabase\.rpc\("set_project_trade_assignment"/);
});

test("assignment changes update inherited unbooked tasks but preserve overrides and visit history", () => {
  assert.match(migration, /visit_id is null[\s\S]*trade_contact_inherited = true/);
  assert.match(migration, /set contact_id = p_contact_id/);
  assert.match(migration, /set contact_id = null/);
  assert.match(taskRoute, /update\.trade_contact_inherited = false/);
  assert.match(taskRoute, /update\.trade_contact_inherited = true/);
  assert.match(taskRoute, /existing\.visit_id \|\| hasExplicitContact/);
  assert.match(boardRoute, /tradeContactInherited = true/);
});

test("Scope and grouped booking both consume the same project trade roster", () => {
  assert.match(sowBuilder, /Project trade team/);
  assert.match(sowBuilder, /feeds unbooked Work tasks/);
  assert.match(sowBuilder, /Contractor not assigned/);
  assert.match(bookingPanel, /Project trade team/);
  assert.match(bookingPanel, /assignment\.role_key === resolvedRole/);
});
