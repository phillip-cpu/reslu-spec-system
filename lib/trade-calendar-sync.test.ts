import assert from "node:assert/strict";
import test from "node:test";
import { tradeCalendarDedupeKey } from "./trade-calendar-sync.ts";

test("calendar sync dedupes the same visit dates and requeues changed dates", () => {
  const base = {
    visit_id: "visit-1",
    project_id: "project-1",
    contact_id: "contact-1",
    title: "Cabinet installation",
    start_date: "2026-07-23",
    end_date: "2026-07-23",
  };
  assert.equal(
    tradeCalendarDedupeKey(base),
    "calendar_sync:trade_visit:visit-1:2026-07-23:2026-07-23"
  );
  assert.notEqual(
    tradeCalendarDedupeKey(base),
    tradeCalendarDedupeKey({ ...base, start_date: "2026-07-24", end_date: "2026-07-24" })
  );
});
