import assert from "node:assert/strict";
import test from "node:test";
import { realtimeConsultPollDelay } from "./realtime-consult-poll.ts";

test("voice consult polling is responsive first and backs off for long work", () => {
  assert.equal(realtimeConsultPollDelay(0), 250);
  assert.equal(realtimeConsultPollDelay(4_999), 250);
  assert.equal(realtimeConsultPollDelay(5_000), 500);
  assert.equal(realtimeConsultPollDelay(14_999), 500);
  assert.equal(realtimeConsultPollDelay(15_000), 1_000);
  assert.equal(realtimeConsultPollDelay(Number.NaN), 250);
});
