import assert from "node:assert/strict";
import test from "node:test";
import { buildSectionForecastDates } from "./schedule-cost-timing.ts";

test("estimate sections inherit their linked Timeline phase end date", () => {
  assert.deepEqual(
    buildSectionForecastDates({
      sections: [
        { id: "joinery", forecast_phase_id: "first-fix" },
        { id: "stone", forecast_phase_id: "tiling" },
        { id: "unlinked", forecast_phase_id: null },
      ],
      phases: [
        { id: "first-fix", end_date: "2026-08-21" },
        { id: "tiling", end_date: "2026-09-04" },
      ],
    }),
    {
      joinery: "2026-08-21",
      stone: "2026-09-04",
    }
  );
});

test("a stale phase link stays visibly undated", () => {
  assert.deepEqual(
    buildSectionForecastDates({
      sections: [{ id: "joinery", forecast_phase_id: "deleted-phase" }],
      phases: [],
    }),
    {}
  );
});
