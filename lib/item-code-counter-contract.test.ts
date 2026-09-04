import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL(
    "../supabase/migrations/20260904060918_reconcile_item_code_counters.sql",
    import.meta.url
  ),
  "utf8"
);
const createRoute = readFileSync(
  new URL("../app/api/projects/[id]/items/route.ts", import.meta.url),
  "utf8"
);

test("generated item codes reconcile against the register before atomic allocation", () => {
  assert.match(migration, /max\(substr\(item\.item_code[\s\S]*\+ 1[\s\S]*into v_next_available/i);
  assert.match(
    migration,
    /on conflict \(project_id, category\)[\s\S]*greatest\(counter\.next_seq, v_next_available\) \+ 1[\s\S]*returning next_seq - 1/i
  );
});

test("explicit imported codes advance the same project and category counter", () => {
  assert.match(migration, /else[\s\S]*v_suffix := substr\(new\.item_code/i);
  assert.match(
    migration,
    /values \(new\.project_id, new\.category, v_suffix::integer \+ 1\)[\s\S]*greatest\(counter\.next_seq, excluded\.next_seq\)/i
  );
});

test("the migration repairs existing counter drift without moving counters backwards", () => {
  assert.match(
    migration,
    /insert into public\.item_code_counters as counter[\s\S]*select[\s\S]*max\(substr\(item\.item_code[\s\S]*group by item\.project_id, item\.category[\s\S]*greatest\(counter\.next_seq, excluded\.next_seq\)/i
  );
});

test("quick-add returns staff-safe messages for database conflicts", () => {
  assert.match(createRoute, /if \(error\.code === "23505"\)/);
  assert.match(createRoute, /That FF&E code was just used by another item/);
  assert.match(createRoute, /Could not add the FF&E item\. Please try again\./);
});
