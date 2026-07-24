import assert from "node:assert/strict";
import test from "node:test";
import { actionItemsFromText, currentAdelaideWeekEnding } from "./friday-review.ts";

test("Friday week ending uses the upcoming Friday and the Friday just passed on weekends", () => {
  assert.equal(currentAdelaideWeekEnding(new Date("2026-07-20T02:00:00Z")), "2026-07-24");
  assert.equal(currentAdelaideWeekEnding(new Date("2026-07-24T02:00:00Z")), "2026-07-24");
  assert.equal(currentAdelaideWeekEnding(new Date("2026-07-25T02:00:00Z")), "2026-07-24");
  assert.equal(currentAdelaideWeekEnding(new Date("2026-07-26T02:00:00Z")), "2026-07-24");
});

test("action lines are trimmed and blank lines are ignored", () => {
  assert.deepEqual(actionItemsFromText(" Call plumber \n\nOrder tiles\r\n"), ["Call plumber", "Order tiles"]);
});
