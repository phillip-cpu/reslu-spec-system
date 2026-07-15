import assert from "node:assert/strict";
import test from "node:test";
import { isBookedColumnName } from "./board-constants.ts";

test("booked status clears reminders without treating Not Booked as complete", () => {
  assert.equal(isBookedColumnName("Booked"), true);
  assert.equal(isBookedColumnName("Re-booked"), true);
  assert.equal(isBookedColumnName("Not Booked"), false);
  assert.equal(isBookedColumnName("Unbooked"), false);
});
