import assert from "node:assert/strict";
import test from "node:test";
import {
  compactRemainingDuration,
  CURRENT_MARKETING_STRATEGIES,
  marketingStrategySnapshot,
} from "./marketing-strategies.ts";

const recovery = CURRENT_MARKETING_STRATEGIES[0];

if (!recovery) throw new Error("Expected the Google Ads recovery strategy fixture.");

test("activated recovery remains in hold mode before reporting starts", () => {
  const snapshot = marketingStrategySnapshot(
    recovery,
    new Date("2026-08-27T12:00:00+09:30")
  );

  assert.equal(snapshot.phase, "preparing");
  assert.equal(snapshot.completeDays, 0);
  assert.equal(snapshot.progressPercent, 0);
  assert.equal(snapshot.nextCheckpoint?.id, "early-safety-check");
});

test("recovery waits for complete Adelaide reporting days", () => {
  const snapshot = marketingStrategySnapshot(
    recovery,
    new Date("2026-08-28T23:59:59+09:30")
  );

  assert.equal(snapshot.phase, "observing");
  assert.equal(snapshot.completeDays, 0);
  assert.equal(snapshot.reportingDaysRemaining, 7);
  assert.equal(snapshot.progressPercent, 0);
});

test("three-day gate reports three of seven complete days", () => {
  const snapshot = marketingStrategySnapshot(
    recovery,
    new Date("2026-08-31T06:15:00+09:30")
  );

  assert.equal(snapshot.completeDays, 3);
  assert.equal(snapshot.progressPercent, 43);
  assert.equal(snapshot.reviewDue, false);
  assert.equal(snapshot.nextCheckpoint?.id, "seven-day-decision");
});

test("Day 7 remains frozen until the scheduled decision time", () => {
  const waiting = marketingStrategySnapshot(
    recovery,
    new Date("2026-09-04T06:14:00+09:30")
  );
  const due = marketingStrategySnapshot(
    recovery,
    new Date("2026-09-04T06:15:00+09:30")
  );

  assert.equal(waiting.completeDays, 7);
  assert.equal(waiting.progressPercent, 100);
  assert.equal(waiting.reviewDue, false);
  assert.equal(due.phase, "review_due");
  assert.equal(due.reviewDue, true);
  assert.equal(due.nextCheckpoint, null);
});

test("countdown stays readable at day, hour and minute scales", () => {
  assert.equal(compactRemainingDuration(7 * 86_400_000 + 2 * 3_600_000), "7d 2h");
  assert.equal(compactRemainingDuration(3_600_000 + 15 * 60_000), "1h 15m");
  assert.equal(compactRemainingDuration(30_000), "1m");
  assert.equal(compactRemainingDuration(0), "Ready now");
});
