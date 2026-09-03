import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260902133534_item_schedule_requirements.sql", import.meta.url),
  "utf8"
);
const procurementView = readFileSync(
  new URL("../components/items/ProcurementView.tsx", import.meta.url),
  "utf8"
);
const requirementsPanel = readFileSync(
  new URL("../components/items/ItemScheduleRequirementsPanel.tsx", import.meta.url),
  "utf8"
);

test("required-on-site links are constrained at the database boundary", () => {
  assert.match(migration, /unique \(item_id, board_task_id\)/i);
  assert.match(migration, /buffer_days between 0 and 365/i);
  assert.match(migration, /active item not found/i);
  assert.match(migration, /trade-package items do not have separate procurement requirements/i);
  assert.match(migration, /item and work activity must belong to the same project/i);
  assert.match(migration, /before insert or update of project_id, item_id, board_task_id/i);
});

test("the new exposed table has explicit grants and RLS", () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /for all to authenticated using \(true\) with check \(true\)/i);
  assert.match(migration, /revoke all on table public\.item_schedule_requirements[\s\S]*from public, anon, authenticated/i);
  assert.match(migration, /grant select, insert, update, delete[\s\S]*to authenticated, service_role/i);
  assert.match(migration, /security invoker/i);
  assert.match(migration, /set search_path = public, pg_temp/i);
  assert.match(migration, /revoke all on function public\.validate_item_schedule_requirement\(\)[\s\S]*from public, anon/i);
});

test("every foreign key used for lookup or cascade is indexed", () => {
  assert.match(migration, /unique \(item_id, board_task_id\)/i);
  assert.match(migration, /idx_item_schedule_requirements_task[\s\S]*\(board_task_id\)/i);
  assert.match(migration, /idx_item_schedule_requirements_project[\s\S]*\(project_id, item_id\)/i);
  assert.match(migration, /idx_item_schedule_requirements_created_by[\s\S]*\(created_by\)/i);
});

test("procurement detail panels have one clear open state and an explicit close action", () => {
  assert.match(
    procurementView,
    /setScheduleOpenFor\(null\);[\s\S]*setComponentsOpenFor\(\(current\)/
  );
  assert.match(
    procurementView,
    /setComponentsOpenFor\(null\);[\s\S]*setScheduleOpenFor\(\(current\)/
  );
  assert.match(requirementsPanel, />\s*Close\s*<\/button>/);
  assert.doesNotMatch(requirementsPanel, /text-subhead text-nearblack sm:hidden/);
  assert.match(requirementsPanel, /sm:w-\[calc\(100vw-12rem\)\] sm:max-w-3xl/);
  assert.match(requirementsPanel, /No Work activities yet/);
});
