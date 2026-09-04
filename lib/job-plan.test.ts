import assert from "node:assert/strict";
import test from "node:test";
import { buildJobPlan, groupJobPlanThreads, itemCodesInScopeText } from "./job-plan.ts";
import type {
  BuildJobPlanInput,
  JobPlanActivityInput,
  JobPlanCostLineInput,
  JobPlanItemInput,
  JobPlanQuotePackageInput,
} from "../types/job-plan.ts";

const directItem: JobPlanItemInput = {
  id: "item-sw01",
  item_code: "SW-01",
  name: "Oval basin",
  category: "SW",
  location: "Ensuite",
  quantity: 2,
  unit: "ea",
  cost_scope: "direct",
  status: "Specced",
  price_trade: 300,
  lead_time_weeks: 4,
  ordered_at: null,
  eta: null,
};

const activity: JobPlanActivityInput = {
  id: "task-fitoff",
  title: "Plumbing fit-off",
  trade_role: "Plumber",
  phase_name: "Fit Off",
  phase_sort: 9,
  status: "Not Booked",
  booking_date: null,
  booking_end_date: null,
  due_date: null,
  contact_id: null,
  contractor_company: null,
  sow_revision_id: "sow-t1",
};

const costLine: JobPlanCostLineInput = {
  id: "cost-basin",
  section_id: "section-plumbing",
  section_name: "Plumbing",
  description: "Supply basin",
  item_id: directItem.id,
  contact_id: null,
  qty: 2,
  unit: "ea",
  rate_ex_gst: 300,
  cost_ex_gst: null,
  quoted_to_client_ex_gst: null,
  actual_paid_ex_gst: null,
  quote_status: "Q",
};

const quote: JobPlanQuotePackageInput = {
  id: "quote-plumbing",
  title: "Plumbing fixtures",
  status: "awaiting",
  line_ids: [costLine.id],
  item_ids: [],
  supplier_names: ["Plumbing Co"],
  selected_supplier_name: null,
  next_due: "2026-09-12",
};

function baseInput(overrides: Partial<BuildJobPlanInput> = {}): BuildJobPlanInput {
  return {
    sow_id: "sow-t1",
    sow_revision_label: "T1",
    sow_status: "draft",
    scope_lines: [
      {
        id: "scope-basin",
        section_id: "room-ensuite",
        room: "Ensuite",
        text: "SANITARYWARE — Supply and install 2 × SW-01 basins.",
        kind: "inclusion",
        trade: "Plumber",
      },
    ],
    items: [directItem],
    activities: [activity],
    phases: [{ id: "phase-fitoff", name: "Fit Off", sort: 9 }],
    activity_scope_links: [{ task_id: activity.id, sow_line_id: "scope-basin" }],
    item_requirements: [
      {
        item_id: directItem.id,
        board_task_id: activity.id,
        buffer_days: 7,
        required_on_site_date: "2026-10-01",
      },
    ],
    cost_lines: [costLine],
    quote_packages: [quote],
    trade_assignments: [
      { trade_role: "Plumber", contact_id: "contact-1", contractor_company: "Plumbing Co" },
    ],
    include_financials: true,
    ...overrides,
  };
}

test("1 — links an exact project item code from Hone-style scope wording", () => {
  assert.deepEqual(itemCodesInScopeText("Install SW-01 to ensuite", [directItem]).map((row) => row.id), [directItem.id]);
});

test("2 — never treats drawing-like references as items unless that code exists", () => {
  assert.deepEqual(itemCodesInScopeText("Refer drawing A604 and detail BH01", [directItem]), []);
});

test("3 — does not match a shorter item code inside a longer code", () => {
  assert.deepEqual(itemCodesInScopeText("Use SW-010", [directItem]), []);
});

test("4 — one scope clause can connect multiple actual FF&E codes", () => {
  const second = { ...directItem, id: "item-tw01", item_code: "TW-01", name: "Mixer" };
  assert.deepEqual(itemCodesInScopeText("Install SW-01 with TW-01.", [directItem, second]).map((row) => row.id), [directItem.id, second.id]);
});

test("5 — joins Scope, Board, FF&E, Estimate, RFQ and programme into one thread", () => {
  const result = buildJobPlan(baseInput());
  const thread = result.threads[0];
  assert.equal(thread?.items[0]?.id, directItem.id);
  assert.equal(thread?.activities[0]?.id, activity.id);
  assert.equal(thread?.cost_lines[0]?.id, costLine.id);
  assert.equal(thread?.quotes[0]?.id, quote.id);
  assert.equal(thread?.requirements[0]?.required_on_site_date, "2026-10-01");
});

test("6 — uses the project trade assignment when an activity has no override", () => {
  const thread = buildJobPlan(baseInput()).threads[0];
  assert.equal(thread?.contractor_company, "Plumbing Co");
  assert.equal(thread?.contractor_source, "trade_assignment");
});

test("7 — a task-level contractor overrides the project trade assignment", () => {
  const result = buildJobPlan(baseInput({ activities: [{ ...activity, contractor_company: "Fitoff Specialists" }] }));
  assert.equal(result.threads[0]?.contractor_company, "Fitoff Specialists");
  assert.equal(result.threads[0]?.contractor_source, "activity");
});

test("8 — marks an untagged scope inclusion for attention", () => {
  const result = buildJobPlan(baseInput({ scope_lines: [{ ...baseInput().scope_lines[0], trade: null }] }));
  assert.ok(result.threads[0]?.issues.some((issue) => issue.key === "trade"));
});

test("9 — marks a scope inclusion not yet applied to the work plan", () => {
  const result = buildJobPlan(baseInput({ activity_scope_links: [] }));
  assert.ok(result.threads[0]?.issues.some((issue) => issue.key === "activity"));
});

test("10 — identifies activities still linked to an older scope revision", () => {
  const result = buildJobPlan(baseInput({ activities: [{ ...activity, sow_revision_id: "sow-t0" }] }));
  assert.ok(result.threads[0]?.issues.some((issue) => issue.key === "stale-scope"));
});

test("11 — flags a missing direct FF&E trade price", () => {
  const result = buildJobPlan(baseInput({ items: [{ ...directItem, price_trade: null }] }));
  assert.equal(result.coverage.direct_items_missing_price, 1);
  assert.ok(result.threads[0]?.issues.some((issue) => issue.key === "price"));
});

test("12 — does not demand a separate price for an item included in a trade package", () => {
  const result = buildJobPlan(baseInput({ items: [{ ...directItem, cost_scope: "trade_package", price_trade: null }] }));
  assert.equal(result.coverage.direct_items_missing_price, 0);
  assert.ok(!result.threads[0]?.issues.some((issue) => issue.key === "price"));
});

test("13 — protects financial state for non-admin views", () => {
  const result = buildJobPlan(baseInput({ items: [{ ...directItem, price_trade: null }], include_financials: false }));
  assert.equal(result.coverage.direct_items_missing_price, 0);
  assert.ok(!result.threads[0]?.issues.some((issue) => issue.key === "price"));
});

test("14 — quote packages also connect directly through an FF&E item", () => {
  const itemQuote = { ...quote, line_ids: [], item_ids: [directItem.id] };
  const result = buildJobPlan(baseInput({ cost_lines: [], quote_packages: [itemQuote] }));
  assert.equal(result.threads[0]?.quotes[0]?.id, quote.id);
});

test("15 — keeps unconnected estimate, activity and FF&E records visible as coverage gaps", () => {
  const orphanItem = { ...directItem, id: "orphan-item", item_code: "LI-99" };
  const orphanTask = { ...activity, id: "orphan-task" };
  const orphanCost = { ...costLine, id: "orphan-cost", item_id: null };
  const result = buildJobPlan(baseInput({
    items: [directItem, orphanItem],
    activities: [activity, orphanTask],
    cost_lines: [costLine, orphanCost],
  }));
  assert.deepEqual(result.unlinked_items.map((row) => row.id), [orphanItem.id]);
  assert.deepEqual(result.unlinked_activities.map((row) => row.id), [orphanTask.id]);
  assert.deepEqual(result.unlinked_cost_lines.map((row) => row.id), [orphanCost.id]);
});

test("16 — each lens regroups the same thread records rather than copying data", () => {
  const result = buildJobPlan(baseInput());
  assert.equal(groupJobPlanThreads(result.threads, "scope")[0]?.label, "Ensuite");
  assert.equal(groupJobPlanThreads(result.threads, "trade")[0]?.label, "Plumber");
  assert.equal(groupJobPlanThreads(result.threads, "cost")[0]?.label, "Plumbing");
  assert.equal(groupJobPlanThreads(result.threads, "procurement")[0]?.label, "Direct procurement");
  assert.equal(groupJobPlanThreads(result.threads, "programme")[0]?.label, "Fit Off");
});

test("17 — rolls many room clauses into one trade-and-stage work package", () => {
  const first = baseInput().scope_lines[0];
  const result = buildJobPlan(baseInput({
    activities: [],
    activity_scope_links: [],
    scope_lines: [
      { ...first, id: "scope-ensuite", room: "Ensuite", text: "SANITARYWARE — Install SW-01 at fit-off" },
      { ...first, id: "scope-powder", room: "Powder", text: "SANITARYWARE — Install SW-01 at fit-off" },
    ],
  }));
  assert.equal(result.threads.length, 1);
  assert.equal(result.threads[0]?.scope_lines.length, 2);
  assert.deepEqual(result.threads[0]?.rooms, ["Ensuite", "Powder"]);
});

test("18 — programme groups follow construction order rather than alphabetical order", () => {
  const first = baseInput().scope_lines[0];
  const earlyActivity = { ...activity, id: "task-roughin", title: "Plumbing rough-in", phase_name: "Rough In", phase_sort: 3 };
  const result = buildJobPlan(baseInput({
    scope_lines: [first, { ...first, id: "scope-roughin", text: "Set out SW-01 for rough-in" }],
    activities: [activity, earlyActivity],
    activity_scope_links: [
      { task_id: activity.id, sow_line_id: first.id },
      { task_id: earlyActivity.id, sow_line_id: "scope-roughin" },
    ],
  }));
  assert.deepEqual(
    groupJobPlanThreads(result.threads, "programme").map((group) => group.label),
    ["Rough In", "Fit Off"]
  );
});
