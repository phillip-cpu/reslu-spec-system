import assert from "node:assert/strict";
import test from "node:test";
import {
  applyProjectDataQualityDismissals,
  compactProjectDataQuality,
  dataQualityIssueFingerprint,
  deriveProjectDataQuality,
} from "./project-data-quality.ts";
import type { ProjectDataQualityInput } from "../types/data-quality.ts";

function baseInput(): ProjectDataQualityInput {
  return {
    project_id: "project-1",
    today: "2026-07-14",
    items: [],
    room_item_ids: [],
    columns: [
      { id: "todo", name: "Not Booked" },
      { id: "progress", name: "In Progress" },
      { id: "done", name: "Done" },
    ],
    tasks: [],
    visits: [],
    order_by: [],
  };
}

function item(overrides: Partial<ProjectDataQualityInput["items"][number]> = {}) {
  return {
    id: "item-1",
    item_code: "DR-01",
    category: "DR",
    name: "Sliding door",
    quantity: 1,
    cost_scope: "direct" as const,
    status: "Specced",
    supplier: "Bone Timber",
    supplier_contact_id: null,
    price_trade: 100,
    price_rrp: null,
    lead_time_weeks: 2,
    ordered_at: null,
    delivered_at: null,
    ...overrides,
  };
}

test("reports an empty register without inventing pricing coverage", () => {
  const report = deriveProjectDataQuality(baseInput());
  assert.equal(report.issues[0]?.code, "register_empty");
  assert.equal(report.pricing.total_items, 0);
  assert.equal(report.pricing.priced_item_pct, 0);
});

test("trade-package reference items do not create room, price or procurement warnings", () => {
  const input = baseInput();
  input.items = [
    item({
      cost_scope: "trade_package",
      quantity: 0,
      supplier: null,
      price_trade: null,
      price_rrp: null,
      lead_time_weeks: null,
    }),
  ];
  input.order_by = [
    {
      item_id: "item-1",
      status: "overdue",
      order_by: "2026-07-01",
      works_date: "2026-07-10",
    },
  ];

  const report = deriveProjectDataQuality(input);
  const ignoredCodes = new Set([
    "quantity_zero",
    "room_missing",
    "supplier_missing",
    "price_missing",
    "quoted_without_price",
    "lead_time_missing",
    "ordering_overdue",
  ]);

  assert.equal(report.pricing.total_items, 0);
  assert.equal(report.issues.some((issue) => ignoredCodes.has(issue.code)), false);
});

test("separates item pricing coverage from quoted share of known value", () => {
  const input = baseInput();
  input.items = [
    item(),
    item({ id: "item-2", item_code: "DR-02", price_trade: null, price_rrp: 50 }),
    item({ id: "item-3", item_code: "DR-03", price_trade: null, price_rrp: null }),
  ];
  input.room_item_ids = input.items.map((row) => row.id);

  const report = deriveProjectDataQuality(input);

  assert.equal(report.pricing.priced_item_pct, 67);
  assert.equal(report.pricing.quoted_value_pct, 67);
  assert.equal(report.pricing.unpriced_items, 1);
  assert.ok(report.issues.some((issue) => issue.code === "price_missing" && issue.count === 1));
});

test("surfaces overdue ordering as critical", () => {
  const input = baseInput();
  input.items = [item()];
  input.room_item_ids = ["item-1"];
  input.order_by = [{ item_id: "item-1", status: "overdue", order_by: "2026-07-01", works_date: "2026-07-23" }];

  const report = deriveProjectDataQuality(input);
  const issue = report.issues.find((row) => row.code === "ordering_overdue");

  assert.equal(issue?.severity, "critical");
  assert.equal(issue?.href, "/projects/project-1?tab=ffe&focus=ordering_due-item-1");
});

test("flags unconfirmed visits inside the fourteen-day booking window", () => {
  const input = baseInput();
  input.items = [item()];
  input.room_item_ids = ["item-1"];
  input.visits = [{ id: "visit-1", status: "tentative", start_date: "2026-07-23", end_date: "2026-07-23" }];

  const report = deriveProjectDataQuality(input);
  const issue = report.issues.find((row) => row.code === "trade_confirmation_due");

  assert.equal(issue?.count, 1);
  assert.equal(issue?.severity, "warning");
});

test("flags future tasks marked in progress after the grace window", () => {
  const input = baseInput();
  input.items = [item()];
  input.room_item_ids = ["item-1"];
  input.tasks = [
    {
      id: "task-1",
      title: "Install sliding doors",
      column_id: "progress",
      booking_date: "2026-07-30",
      booking_end_date: "2026-07-30",
      visit_id: null,
    },
  ];

  const report = deriveProjectDataQuality(input);
  const issue = report.issues.find((row) => row.code === "future_task_in_progress");

  assert.equal(issue?.count, 1);
  assert.equal(issue?.href, "/projects/project-1/board?focus=board_task-task-1");
});

test("a clean, fully populated project has no issues", () => {
  const input = baseInput();
  input.items = [item({ status: "Ordered", ordered_at: "2026-07-12" })];
  input.room_item_ids = ["item-1"];
  input.order_by = [{ item_id: "item-1", status: "ok", order_by: "2026-08-01", works_date: "2026-08-15" }];
  input.visits = [{ id: "visit-1", status: "confirmed", start_date: "2026-08-15", end_date: "2026-08-15" }];

  const report = deriveProjectDataQuality(input);

  assert.deepEqual(report.issues, []);
  assert.equal(report.pricing.priced_item_pct, 100);
});

test("affected record count is not capped by the three displayed samples", () => {
  const input = baseInput();
  input.items = Array.from({ length: 5 }, (_, index) =>
    item({
      id: `item-${index + 1}`,
      item_code: `DR-0${index + 1}`,
      quantity: 0,
    })
  );
  input.room_item_ids = input.items.map((row) => row.id);

  const report = deriveProjectDataQuality(input);
  const issue = report.issues.find((row) => row.code === "quantity_zero");

  assert.equal(issue?.samples.length, 3);
  assert.equal(report.summary.affected_records, 5);
});

test("compact company feed keeps every issue without verbose samples", () => {
  const input = baseInput();
  input.items = [
    item({ quantity: 0, supplier: null, lead_time_weeks: null }),
    item({ id: "item-2", item_code: "DR-02", price_trade: null }),
  ];

  const full = deriveProjectDataQuality(input);
  const compact = compactProjectDataQuality(full);

  assert.deepEqual(
    compact.issues.map((issue) => issue.code),
    full.issues.map((issue) => issue.code)
  );
  assert.equal(compact.summary.warning, full.summary.warning);
  assert.equal(compact.pricing.total_items, 2);
  assert.ok(!("samples" in compact.issues[0]));
  assert.ok(!("detail" in compact.issues[0]));
});

test("issue fingerprints are stable regardless of entity order", () => {
  const entities = [
    { id: "item-2", label: "Second", kind: "item" as const },
    { id: "item-1", label: "First", kind: "item" as const },
  ];

  assert.equal(
    dataQualityIssueFingerprint("price_missing", entities),
    dataQualityIssueFingerprint("price_missing", [...entities].reverse())
  );
});

test("an exact dismissal hides the issue but changed affected data resurfaces it", () => {
  const input = baseInput();
  input.items = [
    item({ price_trade: null, price_rrp: null }),
    item({
      id: "item-2",
      item_code: "DR-02",
      price_trade: null,
      price_rrp: null,
    }),
  ];
  input.room_item_ids = input.items.map((row) => row.id);
  const report = deriveProjectDataQuality(input);
  const issue = report.issues.find((row) => row.code === "price_missing");
  assert.ok(issue);

  const hidden = applyProjectDataQualityDismissals(
    report,
    new Map([[issue.code, issue.fingerprint]])
  );
  assert.equal(hidden.issues.some((row) => row.code === "price_missing"), false);
  assert.equal(hidden.dismissed_count, 1);

  input.items.push(
    item({
      id: "item-3",
      item_code: "DR-03",
      price_trade: null,
      price_rrp: null,
    })
  );
  input.room_item_ids.push("item-3");
  const changed = deriveProjectDataQuality(input);
  const resurfaced = applyProjectDataQualityDismissals(
    changed,
    new Map([[issue.code, issue.fingerprint]])
  );
  assert.equal(resurfaced.issues.some((row) => row.code === "price_missing"), true);
});
