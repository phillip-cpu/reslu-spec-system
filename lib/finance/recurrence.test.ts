import assert from "node:assert/strict";
import test from "node:test";
import { generateRecurringContributions, generateRecurringOccurrences, isRecurringOccurrenceDate, normalizeRecurringPayment } from "./recurrence.ts";
import type { FinanceRecurringOccurrencePayment } from "./recurrence.ts";
import { calculateShadowProjection } from "./projection.ts";
import type { FinanceRecurringCommitment } from "../../types/finance.ts";

function commitment(
  overrides: Partial<FinanceRecurringCommitment> = {}
): FinanceRecurringCommitment {
  return {
    id: "00000000-0000-0000-0000-000000000081",
    name: "Office rent",
    category: "rent",
    supplier_or_payee: "Landlord",
    amount_minor: 550_000,
    frequency: "monthly",
    first_due_date: "2026-01-31",
    end_date: null,
    gst_treatment: "inclusive",
    annual_escalation_bps: 0,
    confidence: "confirmed",
    status: "active",
    notes: null,
    version: 1,
    created_by: null,
    updated_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("month-end commitments remain anchored to the intended calendar day", () => {
  const contributions = generateRecurringContributions({
    commitments: [commitment()],
    asOfDate: "2026-01-01",
    weeklyPeriods: 20,
  });
  assert.deepEqual(
    contributions.slice(0, 4).map((item) => item.plannedDate),
    ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]
  );
});

test("past occurrences stay in opening cash and only future occurrences are forecast", () => {
  const contributions = generateRecurringContributions({
    commitments: [
      commitment({ frequency: "fortnightly", first_due_date: "2026-07-24" }),
    ],
    asOfDate: "2026-08-06",
    weeklyPeriods: 4,
  });
  assert.deepEqual(
    contributions.map((item) => item.plannedDate),
    ["2026-08-07", "2026-08-21"]
  );
});

test("one-time expected outgoings enter the forecast exactly once", () => {
  const contributions = generateRecurringContributions({
    commitments: [
      commitment({
        name: "Marketing launch",
        category: "marketing",
        frequency: "once",
        first_due_date: "2026-08-20",
      }),
    ],
    asOfDate: "2026-08-06",
    weeklyPeriods: 13,
  });

  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].plannedDate, "2026-08-20");
  assert.equal(contributions[0].plannedMinor, 550_000);
  assert.equal(contributions[0].sourceTrace?.frequency, "once");
});

test("past one-time expected outgoings do not repeat into the forecast", () => {
  const contributions = generateRecurringContributions({
    commitments: [
      commitment({ frequency: "once", first_due_date: "2026-08-05" }),
    ],
    asOfDate: "2026-08-06",
    weeklyPeriods: 13,
  });

  assert.deepEqual(contributions, []);
});

test("paused and ended commitments do not leak into the company base", () => {
  const contributions = generateRecurringContributions({
    commitments: [
      commitment({ id: "paused", status: "paused", first_due_date: "2026-08-07" }),
      commitment({ id: "ended", first_due_date: "2026-07-01", end_date: "2026-07-31" }),
    ],
    asOfDate: "2026-08-06",
  });
  assert.deepEqual(contributions, []);
});

test("annual escalation compounds from the anchor anniversary in integer minor units", () => {
  const contributions = generateRecurringContributions({
    commitments: [
      commitment({
        amount_minor: 100_000,
        frequency: "annually",
        first_due_date: "2025-08-10",
        annual_escalation_bps: 500,
      }),
    ],
    asOfDate: "2026-08-01",
    weeklyPeriods: 4,
  });
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].plannedMinor, 105_000);
  assert.equal(contributions[0].contributionKey.endsWith(":2026-08-10"), true);
});

test("recurrence identities are stable and traceable to the company commitment", () => {
  const item = commitment({ first_due_date: "2026-08-07", frequency: "weekly" });
  const [first] = generateRecurringContributions({
    commitments: [item],
    asOfDate: "2026-08-06",
    weeklyPeriods: 1,
  });
  assert.equal(first.contributionKey, `recurring:${item.id}:2026-08-07`);
  assert.equal(first.sourceTrace?.recurring_commitment_id, item.id);
  assert.equal(first.direction, "outflow");
});

function payment(overrides: Partial<FinanceRecurringOccurrencePayment> = {}): FinanceRecurringOccurrencePayment {
  return {
    commitment_id: commitment().id, due_date: "2026-09-11", scheduled_amount_minor: 550_000,
    amount_paid_minor: 550_000, paid_on: "2026-09-04", version: 1,
    payment_entries: [{ amount_minor: 550_000, paid_on: "2026-09-04" }], ...overrides,
  };
}

test("an early payment last week removes this week's recurring forecast", () => {
  const contributions = generateRecurringContributions({
    commitments: [commitment({ first_due_date: "2026-09-11", frequency: "once", tracking_started_on: "2026-09-01" })],
    payments: [payment()], asOfDate: "2026-09-08", weeklyPeriods: 1,
  });
  assert.equal(contributions.reduce((sum, item) => sum + item.plannedMinor, 0), 0);
  assert.equal(contributions[0].actualPaidDate, "2026-09-04");
  const projection = calculateShadowProjection({ asOfDate: "2026-09-08", openingCashMinor: 1_000_000, contributions });
  assert.equal(projection.periods[0].outflowMinor, 0);
});

test("partial settlement forecasts only the outstanding amount", () => {
  const contributions = generateRecurringContributions({
    commitments: [commitment({ first_due_date: "2026-09-11", frequency: "once" })],
    payments: [payment({ amount_paid_minor: 100_000, payment_entries: [{ amount_minor: 100_000, paid_on: "2026-09-04" }] })],
    asOfDate: "2026-09-08", weeklyPeriods: 1,
  });
  assert.equal(contributions.reduce((sum, item) => sum + item.plannedMinor, 0), 450_000);
  assert.equal(contributions.reduce((sum, item) => sum + (item.actualPaidMinor ?? 0), 0), 100_000);
});

test("two partial payments keep their separate cash dates", () => {
  const contributions = generateRecurringContributions({
    commitments: [commitment({ first_due_date: "2026-09-11", frequency: "once" })],
    payments: [payment({ amount_paid_minor: 150_000, paid_on: "2026-09-08", version: 2,
      payment_entries: [{ amount_minor: 100_000, paid_on: "2026-09-04" }, { amount_minor: 50_000, paid_on: "2026-09-08" }] })],
    asOfDate: "2026-09-08", weeklyPeriods: 1,
  });
  assert.deepEqual(contributions.filter((item) => item.actualPaidMinor).map((item) => [item.actualPaidMinor, item.actualPaidDate]),
    [[100_000, "2026-09-04"], [50_000, "2026-09-08"]]);
  const projection = calculateShadowProjection({ asOfDate: "2026-09-08", openingCashMinor: 1_000_000, contributions });
  assert.equal(projection.periods[0].outflowMinor, 450_000);
});

test("tracked unpaid Monday does not disappear on Tuesday or the following week", () => {
  const item = commitment({ first_due_date: "2026-09-07", frequency: "weekly", tracking_started_on: "2026-09-07" });
  for (const asOfDate of ["2026-09-08", "2026-09-15"]) {
    const contributions = generateRecurringContributions({ commitments: [item], asOfDate, weeklyPeriods: 1 });
    assert.ok(contributions.some((row) => row.plannedDate === "2026-09-07" && row.plannedMinor === 550_000));
  }
});

test("tracking starts prospectively without inventing earlier unpaid occurrences", () => {
  const item = commitment({ first_due_date: "2026-08-03", frequency: "weekly", tracking_started_on: "2026-09-08" });
  const current = generateRecurringContributions({ commitments: [item], asOfDate: "2026-09-15", weeklyPeriods: 1 });
  assert.deepEqual(current.map((row) => row.plannedDate), ["2026-09-14"]);
  const historical = generateRecurringContributions({ commitments: [item], asOfDate: "2026-08-11", weeklyPeriods: 1 });
  assert.deepEqual(historical, []);
});

test("paid and part-paid history survives archiving or changing the recurrence anchor", () => {
  const item = commitment({ first_due_date: "2026-10-01", status: "archived" });
  const contributions = generateRecurringContributions({ commitments: [item], payments: [payment({
    amount_paid_minor: 100_000, payment_entries: [{ amount_minor: 100_000, paid_on: "2026-09-04" }],
  })], asOfDate: "2026-09-08", weeklyPeriods: 1 });
  assert.equal(contributions.length, 2);
  assert.equal(contributions[0].plannedMinor, 450_000);
  assert.equal(contributions[1].actualPaidDate, "2026-09-04");
});

test("exact occurrence validation supports month ends but rejects arbitrary dates", () => {
  const item = commitment();
  assert.equal(isRecurringOccurrenceDate(item, "2026-02-28"), true);
  assert.equal(isRecurringOccurrenceDate(item, "2026-03-31"), true);
  assert.equal(isRecurringOccurrenceDate(item, "2026-03-28"), false);
  assert.equal(isRecurringOccurrenceDate(item, "2026-02-30"), false);
  assert.equal(isRecurringOccurrenceDate({ ...item, end_date: "2026-02-28" }, "2026-03-31"), false);
});

test("historical previews do not use payments that happened after their as-of date", () => {
  const [occurrence] = generateRecurringOccurrences({
    commitments: [commitment({ first_due_date: "2026-09-11", frequency: "once" })],
    payments: [payment({ paid_on: "2026-09-08", payment_entries: [{ amount_minor: 550_000, paid_on: "2026-09-08" }] })],
    asOfDate: "2026-09-07", weeklyPeriods: 1,
  });
  assert.equal(occurrence.remaining_minor, 550_000);
  assert.equal(occurrence.paid_minor, 0);
});

test("payment normalization rejects contradictory or unsafe ledger totals", () => {
  assert.equal(normalizeRecurringPayment(payment() as unknown as Record<string, unknown>).amount_paid_minor, 550_000);
  assert.throws(() => normalizeRecurringPayment({ ...payment(), amount_paid_minor: 1 }), /invalid/);
  assert.throws(() => normalizeRecurringPayment({ ...payment(), payment_entries: [{ amount_minor: 550_000, paid_on: "2026-02-30" }] }), /invalid/);
});

test("a paid occurrence beyond the horizon preserves early cash without adding future remaining costs", () => {
  const contributions = generateRecurringContributions({ commitments: [commitment({ first_due_date: "2026-12-31", frequency: "once" })],
    payments: [payment({ due_date: "2026-12-31", amount_paid_minor: 100_000,
      payment_entries: [{ amount_minor: 100_000, paid_on: "2026-09-08" }] })], asOfDate: "2026-09-08", weeklyPeriods: 1 });
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0].actualPaidMinor, 100_000);
  assert.equal(contributions[0].plannedMinor, 0);
});

test("undoing the last payment restores the obligation without resetting optimistic version", () => {
  const corrected = normalizeRecurringPayment({ ...payment(), amount_paid_minor: 0, paid_on: null,
    payment_entries: [], version: 3 });
  const [occurrence] = generateRecurringOccurrences({ commitments: [commitment({
    first_due_date: "2026-09-11", frequency: "once", status: "archived",
  })], payments: [corrected], asOfDate: "2026-09-15", weeklyPeriods: 1 });
  assert.equal(occurrence.remaining_minor, 550_000);
  assert.equal(occurrence.paid_minor, 0);
  assert.equal(occurrence.payment_version, 3);
  assert.deepEqual(occurrence.payment_entries, []);
});

test("a newly entered overdue one-time outgoing remains visible", () => {
  const item = commitment({ frequency: "once", first_due_date: "2026-09-01",
    tracking_started_on: "2026-09-01", created_at: "2026-09-08T01:00:00Z" });
  for (const asOfDate of ["2026-09-08", "2026-09-15"]) {
    const contributions = generateRecurringContributions({ commitments: [item], asOfDate, weeklyPeriods: 1 });
    assert.equal(contributions.length, 1);
    assert.equal(contributions[0].plannedDate, "2026-09-01");
    assert.equal(contributions[0].plannedMinor, 550_000);
  }
});

test("prospective tracking does not fabricate migrated or repeating backlog", () => {
  const current = commitment({ frequency: "once", first_due_date: "2026-09-01",
    tracking_started_on: "2026-09-08", created_at: "2026-09-08T01:00:00Z" });
  const migrated = { ...current, created_at: "2026-08-01T01:00:00Z" };
  assert.deepEqual(generateRecurringContributions({ commitments: [migrated], asOfDate: "2026-09-08", weeklyPeriods: 1 }), []);
  assert.deepEqual(generateRecurringContributions({ commitments: [current], asOfDate: "2026-09-07", weeklyPeriods: 1 }), []);
  const repeating = generateRecurringContributions({ commitments: [{ ...current, frequency: "weekly" }], asOfDate: "2026-09-08", weeklyPeriods: 1 });
  assert.deepEqual(repeating.map((item) => item.plannedDate), ["2026-09-08"]);
});
