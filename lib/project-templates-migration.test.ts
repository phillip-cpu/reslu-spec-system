import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../supabase/migrations/20260821014237_project_type_templates.sql", import.meta.url),
  "utf8"
);

test("project type migration adds constrained nullable rollout fields", () => {
  assert.match(migration, /add column if not exists project_type text/i);
  assert.match(migration, /add column if not exists project_subtype text/i);
  assert.match(migration, /project_type is null/i);
  assert.match(migration, /single_room_renovation/i);
  assert.match(migration, /project_subtype in \('kitchen', 'bathroom', 'ensuite', 'laundry', 'other'\)/i);
  assert.match(migration, /project_type is distinct from 'single_room_renovation' and project_subtype is null/i);
  assert.match(migration, /notify pgrst, 'reload schema'/i);
  assert.match(migration, /alter table leads\s+add column if not exists project_type_code text/i);
  assert.match(migration, /alter table leads\s+add column if not exists project_subtype text/i);
});
