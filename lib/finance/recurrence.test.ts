import assert from "node:assert/strict";
import test from "node:test";
import { generateRecurringContributions } from "./recurrence.ts";
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
