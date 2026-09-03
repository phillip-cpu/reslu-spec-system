import assert from "node:assert/strict";
import test from "node:test";
import { summarizeForecastSchedule } from "./forecast-readiness.ts";

test("forecast schedule summary reports complete phase coverage and latest date", () => {
  assert.deepEqual(
    summarizeForecastSchedule([
      { start_date: "2026-07-10", end_date: "2026-07-14" },
      { start_date: "2026-08-24", end_date: "2026-08-28" },
    ]),
    {
      phaseCount: 2,
      datedPhaseCount: 2,
      latestScheduleDate: "2026-08-28",
    }
  );
});

test("forecast schedule summary keeps partial dates visible without calling them complete", () => {
  assert.deepEqual(
    summarizeForecastSchedule([
      { start_date: "2026-09-04", end_date: null },
      { start_date: null, end_date: "not-a-date" },
      {},
    ]),
    {
      phaseCount: 3,
      datedPhaseCount: 0,
      latestScheduleDate: "2026-09-04",
    }
  );
});

test("forecast schedule summary handles an empty Timeline", () => {
  assert.deepEqual(summarizeForecastSchedule([]), {
    phaseCount: 0,
    datedPhaseCount: 0,
    latestScheduleDate: null,
  });
});
