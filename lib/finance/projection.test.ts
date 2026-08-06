import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWeeklyPeriods,
  calculateShadowProjection,
  resolveEffectiveContributions,
} from "./projection.ts";

test("a cheaper full-scope commitment replaces plan while actual progressively replaces commitment", () => {
  const result = resolveEffectiveContributions([
    {
      contributionKey: "electrical",
      direction: "outflow",
      description: "Electrical",
      plannedMinor: 2_200_000,
      committedMinor: 2_150_000,
      actualAccruedMinor: 770_000,
      actualPaidMinor: 440_000,
      committedDate: "2026-08-24",
      actualDueDate: "2026-08-18",
      actualPaidDate: "2026-08-10",
    },
  ]);

  assert.deepEqual(
    result.contributions.map((item) => [item.state, item.amountMinor]),
    [
      ["actual_paid", 440_000],
      ["actual_accrued", 330_000],
      ["committed", 1_380_000],
    ]
  );
  assert.equal(
    result.contributions.reduce((sum, item) => sum + item.amountMinor, 0),
    2_150_000
  );
});

test("actual without a commitment reduces plan and an overrun floors residual at zero", () => {
  const withinPlan = resolveEffectiveContributions([
    {
      contributionKey: "tiles",
      direction: "outflow",
      description: "Tiles",
      plannedMinor: 1_000_000,
      actualAccruedMinor: 400_000,
      actualPaidMinor: 100_000,
    },
  ]).contributions;
  assert.equal(withinPlan.reduce((sum, item) => sum + item.amountMinor, 0), 1_000_000);
  assert.equal(withinPlan.find((item) => item.state === "planned")?.amountMinor, 600_000);

  const overrun = resolveEffectiveContributions([
    {
      contributionKey: "joinery",
      direction: "outflow",
      description: "Joinery",
      plannedMinor: 2_200_000,
      committedMinor: 2_150_000,
      actualAccruedMinor: 2_310_000,
    },
  ]).contributions;
  assert.deepEqual(overrun.map((item) => [item.state, item.amountMinor]), [
    ["actual_accrued", 2_310_000],
  ]);
});

test("candidate construction is excluded from committed base", () => {
  const result = resolveEffectiveContributions([
    {
      contributionKey: "candidate",
      direction: "outflow",
      description: "Candidate job",
      plannedMinor: 500_000,
      baseEligible: false,
    },
  ]);
  assert.deepEqual(result.contributions, []);
  assert.equal(result.excludedFromBaseMinor, 500_000);
});

test("duplicate identities and paid-over-accrued facts fail closed", () => {
  assert.throws(
    () =>
      resolveEffectiveContributions([
        {
          contributionKey: "same",
          direction: "outflow",
          description: "One",
          plannedMinor: 1,
        },
        {
          contributionKey: "same",
          direction: "outflow",
          description: "Two",
          plannedMinor: 1,
        },
      ]),
    /Duplicate contribution key/
  );
  assert.throws(
    () =>
      resolveEffectiveContributions([
        {
          contributionKey: "invalid-payment",
          direction: "outflow",
          description: "Invalid",
          plannedMinor: 100,
          actualAccruedMinor: 30,
          actualPaidMinor: 31,
        },
      ]),
    /cannot exceed accrued actual/
  );
});

test("13 weekly periods use Monday-Sunday Adelaide calendar buckets", () => {
  const periods = buildWeeklyPeriods("2026-08-06");
  assert.equal(periods.length, 13);
  assert.deepEqual(periods[0], { startsOn: "2026-08-03", endsOn: "2026-08-09" });
  assert.deepEqual(periods[12], { startsOn: "2026-10-26", endsOn: "2026-11-01" });
});

test("cash periods reconcile exactly and historical paid cash stays in opening balance", () => {
  const projection = calculateShadowProjection({
    asOfDate: "2026-08-06",
    openingCashMinor: 10_000_000,
    weeklyPeriods: 2,
    contributions: [
      {
        contributionKey: "receipt",
        direction: "inflow",
        description: "Receipt",
        plannedMinor: 2_000_000,
        plannedDate: "2026-08-07",
      },
      {
        contributionKey: "bill",
        direction: "outflow",
        description: "Bill",
        plannedMinor: 1_500_000,
        plannedDate: "2026-08-12",
      },
      {
        contributionKey: "historic-payment",
        direction: "outflow",
        description: "Already in opening cash",
        plannedMinor: 500_000,
        actualAccruedMinor: 500_000,
        actualPaidMinor: 500_000,
        actualPaidDate: "2026-08-01",
      },
    ],
  });

  assert.equal(projection.periods[0].closingCashMinor, 12_000_000);
  assert.equal(projection.periods[1].openingCashMinor, 12_000_000);
  assert.equal(projection.periods[1].closingCashMinor, 10_500_000);
  assert.equal(projection.totalInflowMinor, 2_000_000);
  assert.equal(projection.totalOutflowMinor, 1_500_000);
});

test("unknown timing and outside-horizon amounts remain visible, never become zero", () => {
  const projection = calculateShadowProjection({
    asOfDate: "2026-08-06",
    openingCashMinor: 0,
    weeklyPeriods: 1,
    contributions: [
      {
        contributionKey: "unknown",
        direction: "outflow",
        description: "Unknown date",
        plannedMinor: 250_000,
      },
      {
        contributionKey: "later",
        direction: "outflow",
        description: "Later",
        plannedMinor: 125_000,
        plannedDate: "2026-12-01",
      },
    ],
  });
  assert.equal(projection.unknownTimingMinor, 250_000);
  assert.equal(projection.outsideHorizonMinor, 125_000);
  assert.equal(projection.totalOutflowMinor, 0);
});
