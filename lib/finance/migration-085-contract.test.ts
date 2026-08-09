import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  new URL("../../supabase/migrations/085_schedule_driven_cost_forecast.sql", import.meta.url),
  "utf8"
);

test("estimate sections persist one schedule-driven forecast phase", () => {
  assert.match(sql, /alter table cost_sections/i);
  assert.match(sql, /forecast_phase_id uuid/i);
  assert.match(sql, /references schedule_phases\(id\) on delete set null/i);
  assert.match(sql, /idx_cost_sections_forecast_phase/i);
});
