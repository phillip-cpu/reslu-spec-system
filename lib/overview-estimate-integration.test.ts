import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../app/api/projects/[id]/overview/route.ts", import.meta.url),
  "utf8"
);

test("project Overview prices measurement-linked trade and FF&E quantities like Estimate", () => {
  assert.match(route, /\.from\("measurements"\)[\s\S]*\.select\("id, value"\)/);
  assert.match(
    route,
    /measurement_id, wastage_pct, coverage_per_unit/
  );
  assert.match(route, /sectionRollup\([\s\S]*measurementsById/);
  assert.match(route, /projectRollup\(\{[\s\S]*measurementsById/);
  assert.match(route, /ffeRollup\([\s\S]*measurementsById/);
});
