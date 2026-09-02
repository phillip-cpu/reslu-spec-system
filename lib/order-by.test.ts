import assert from "node:assert/strict";
import test from "node:test";
import { deriveOrderBy, missingLeadTimes } from "./order-by.ts";

test("trade-package reference items do not enter ordering workflows", () => {
  const items = [
    {
      id: "hardware",
      project_id: "project-1",
      category: "HD",
      lead_time_weeks: null,
      ordered_at: null,
      cost_scope: "trade_package" as const,
    },
  ];

  assert.deepEqual(deriveOrderBy(items, [], [], []), []);
  assert.deepEqual(missingLeadTimes(items), []);
});

test("an explicit required activity beats the category/contact fallback", () => {
  const [result] = deriveOrderBy(
    [{
      id: "tapware",
      project_id: "project-1",
      category: "TW",
      lead_time_weeks: 3,
      ordered_at: null,
      cost_scope: "direct" as const,
    }],
    [],
    [],
    [],
    new Date("2026-09-01T00:00:00Z"),
    [{
      id: "requirement-1",
      project_id: "project-1",
      item_id: "tapware",
      board_task_id: "rough-in-task",
      buffer_days: 2,
      activity_title: "Plumbing rough-in",
      trade_role: "Plumber",
      required_on_site_date: "2026-10-30",
    }]
  );

  assert.equal(result.order_by, "2026-10-07");
  assert.equal(result.works_date, "2026-10-30");
  assert.equal(result.timing_basis, "required_activity");
  assert.equal(result.required_trade_role, "Plumber");
  assert.equal(result.source?.source_kind, "board_task_requirement");
});

test("a linked but unscheduled activity does not fall back to an unrelated booking", () => {
  const presets = [{
    id: "plumber",
    name: "Plumber",
    prefixes: ["TW"],
    contact_categories: ["Plumbing"],
  }];
  const [result] = deriveOrderBy(
    [{ id: "tapware", project_id: "project-1", category: "TW", lead_time_weeks: 2, ordered_at: null }],
    presets,
    [{ id: "contact-1", category: "Plumbing" }],
    [{
      source_id: "unrelated-visit",
      source_kind: "visit",
      project_id: "project-1",
      contact_id: "contact-1",
      start_date: "2026-09-30",
    }],
    new Date("2026-09-01T00:00:00Z"),
    [{
      id: "requirement-1",
      project_id: "project-1",
      item_id: "tapware",
      board_task_id: "fitoff-task",
      buffer_days: 0,
      activity_title: "Plumbing fit-off",
      trade_role: "Plumber",
      required_on_site_date: null,
    }]
  );

  assert.equal(result.status, "no_booking");
  assert.equal(result.order_by, null);
  assert.equal(result.required_activity_id, "fitoff-task");
});

test("the earliest buffered requirement controls a multi-stage item", () => {
  const [result] = deriveOrderBy(
    [{ id: "mixer", project_id: "project-1", category: "TW", lead_time_weeks: 1, ordered_at: null }],
    [],
    [],
    [],
    new Date("2026-09-01T00:00:00Z"),
    [
      {
        id: "requirement-rough-in",
        project_id: "project-1",
        item_id: "mixer",
        board_task_id: "rough-in-task",
        buffer_days: 0,
        activity_title: "Plumbing rough-in",
        trade_role: "Plumber",
        required_on_site_date: "2026-11-10",
      },
      {
        id: "requirement-fitoff",
        project_id: "project-1",
        item_id: "mixer",
        board_task_id: "fitoff-task",
        buffer_days: 6,
        activity_title: "Plumbing fit-off",
        trade_role: "Plumber",
        required_on_site_date: "2026-11-12",
      },
    ]
  );

  assert.equal(result.required_activity_id, "fitoff-task");
  assert.equal(result.works_date, "2026-11-12");
  assert.equal(result.order_by, "2026-10-30");
});
