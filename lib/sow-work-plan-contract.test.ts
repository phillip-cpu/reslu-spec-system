import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read("supabase/migrations/20260904010918_link_sow_to_work_plan.sql");
const route = read("app/api/projects/[id]/sow/[sowId]/work-plan/route.ts");
const builder = read("components/sow/SowBuilder.tsx");
const boardRoute = read("app/api/projects/[id]/board/route.ts");
const boardPage = read("app/(dashboard)/projects/[id]/board/page.tsx");

test("Scope provenance is relational, secured and duplicate-safe", () => {
  assert.match(migration, /create table if not exists public\.board_task_sow_lines/);
  assert.match(migration, /unique \(task_id, sow_line_id\)/);
  assert.match(migration, /uq_board_tasks_active_sow_work_key/);
  assert.match(migration, /where deleted_at is null and sow_work_key is not null/);
  assert.match(migration, /alter table public\.board_task_sow_lines enable row level security/);
  assert.match(migration, /revoke all on table public\.board_task_sow_lines[\s\S]*from public, anon, authenticated/);
  assert.match(migration, /grant select, insert, update, delete[\s\S]*to authenticated, service_role/);
});

test("one reviewed package is applied atomically without privileged RLS bypass", () => {
  assert.match(migration, /create or replace function public\.apply_sow_work_plan_package/);
  assert.match(migration, /security invoker/);
  assert.doesNotMatch(migration, /security definer/i);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /line\.id = any\(p_line_ids\)/);
  assert.match(migration, /line\.kind = 'inclusion'/);
  assert.match(migration, /lower\(btrim\(line\.trade\)\) = lower\(btrim\(p_trade_role\)\)/);
  assert.match(migration, /if p_phase_group_id is null/);
  assert.match(migration, /exception when unique_violation/);
  assert.match(migration, /delete from public\.board_task_sow_lines[\s\S]*insert into public\.board_task_sow_lines/);
  assert.match(migration, /revoke all on function public\.apply_sow_work_plan_package[\s\S]*from public, anon/);
});

test("the API recomputes previews before writes and rejects stale selections", () => {
  assert.match(route, /loadWorkPlanContext\(supabase, projectId, sowId\)/g);
  assert.doesNotMatch(route, /seedPhaseTemplateIfEmpty/);
  assert.match(route, /unknownKeys\.length > 0/);
  assert.match(route, /changedKeys\.length > 0/);
  assert.match(route, /unplannedKeys\.length > 0/);
  assert.match(route, /suggestionsByKey\.get\(selection\.key\)\?\.fingerprint/);
  assert.match(route, /changed after this preview/);
  assert.match(route, /supabase\.rpc\("apply_sow_work_plan_package"/);
  assert.match(route, /suggestion\.state === "current"/);
});

test("Scope offers a review-first Work Plan action and both board reads show provenance", () => {
  assert.match(builder, /Build work plan/);
  assert.match(builder, /Review before adding anything to Work/);
  assert.match(builder, /Existing task names,[\s\S]*dates, statuses and contractor overrides are preserved/);
  assert.match(builder, /package[\s\S]*a phase\. These are left unchecked by default/);
  assert.match(boardRoute, /addSowContextToBoardTasks/);
  assert.match(boardPage, /addSowContextToBoardTasks/);
});
