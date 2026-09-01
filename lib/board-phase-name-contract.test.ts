import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const migration = read(
  "supabase/migrations/20260901112448_prevent_duplicate_board_group_names.sql"
);
const createRoute = read("app/api/projects/[id]/board/groups/route.ts");
const updateRoute = read("app/api/board-groups/[id]/route.ts");

test("phase-name uniqueness is serialized and enforced in the database", () => {
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /before insert or update of project_id, name/);
  assert.match(migration, /errcode = '23505'/);
  assert.match(migration, /regexp_replace\(btrim\(sibling\.name\), '\\s\+'/);
});

test("board group APIs surface database duplicate conflicts", () => {
  for (const route of [createRoute, updateRoute]) {
    assert.match(route, /error\.code === "23505" \? 409 : 500/);
  }
});

test("a losing concurrent create removes only its newly-created Timeline phase", () => {
  assert.match(createRoute, /let createdPhaseId: string \| null = null/);
  assert.match(createRoute, /createdPhaseId = newPhase\.id/);
  assert.match(
    createRoute,
    /if \(createdPhaseId\) \{\s*await supabase\.from\("schedule_phases"\)\.delete\(\)\.eq\("id", createdPhaseId\)/
  );
});
