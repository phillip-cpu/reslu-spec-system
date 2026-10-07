import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as recurrence from "../../../../lib/finance/recurrence.ts";
import * as recurringPresentation from "../../../../lib/finance/recurring-presentation.ts";
import * as presentation from "../../../../lib/finance/presentation.ts";
import * as projection from "../../../../lib/finance/projection.ts";
import * as readiness from "../../../../lib/finance/readiness.ts";

// Synthetic amounts reproduce the Shift/Moneytech rollover without publishing financial records.
// Run the real GET and panel with mocked persistence/hooks; no client or network is loaded.
const root = resolve(import.meta.dirname, "../../../..");
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { NextRequest, NextResponse } = require("next/server");

function loadSource(path, dependencies) {
  const compiled = ts.transpileModule(readFileSync(resolve(root, path), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, {
    module: compiledModule, exports: compiledModule.exports,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected live dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return compiledModule.exports;
}

function commitment(overrides = {}) {
  return {
    id: "shift", name: "Shift", supplier_or_payee: "Shift", category: "other",
    amount_minor: 100000, frequency: "weekly", first_due_date: "2026-09-04",
    tracking_started_on: "2026-09-04", end_date: "2026-09-30", status: "active",
    gst_treatment: "not_applicable", annual_escalation_bps: 0, confidence: "confirmed",
    notes: null, version: 1, created_by: null, updated_by: null,
    created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

const commitments = [
  commitment(),
  commitment({ id: "moneytech", name: "Moneytech", supplier_or_payee: "Moneytech",
    amount_minor: 170000, first_due_date: "2026-10-02", tracking_started_on: "2026-10-02", end_date: null }),
];
const payments = [{
  commitment_id: "shift", due_date: "2026-09-18", scheduled_amount_minor: 100000,
  amount_paid_minor: 40000, paid_on: "2026-09-21", version: 1,
  payment_entries: [{ amount_minor: 40000, paid_on: "2026-09-21" }],
}];

async function register(asOfDate, rows = commitments) {
  const queries = [];
  const supabase = {
    from(table) {
      queries.push(table);
      const data = table === "finance_recurring_commitments" ? rows
        : table === "finance_recurring_occurrence_payments" ? payments : [];
      const query = {};
      for (const method of ["select", "order", "limit", "eq", "not"]) {
        query[method] = () => query;
      }
      query.then = (onFulfilled, onRejected) =>
        Promise.resolve({ data, error: null, count: data.length }).then(onFulfilled, onRejected);
      return query;
    },
  };
  const { GET } = loadSource("app/api/finance/recurring-payments/route.ts", {
    "next/server": { NextRequest, NextResponse },
    "@/lib/auth": { getUserRole: async () => ({ role: "owner" }) },
    "@/lib/finance/feature-flags": { financeFoundationEnabled: () => true },
    "@/lib/finance/permissions": {
      hasFinanceCapability: async (_client, name) => ({ allowed: name === "finance.view_company", error: null }),
    },
    "@/lib/finance/recurrence": recurrence,
    "@/lib/finance/recurring-presentation": recurringPresentation,
    "@/lib/finance/projection": projection,
    "@/lib/finance/readiness": readiness,
    "@/lib/supabase/server": { createClient: async () => supabase },
  });
  const response = await GET(new NextRequest(
    `https://example.test/api/finance/recurring-payments?as_of_date=${asOfDate}`
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(queries, ["finance_recurring_commitments", "finance_recurring_occurrence_payments", "invoices"]);
  return response.json();
}

function renderPanel(data, asOfDate = data.as_of_date) {
  let hookIndex = 0;
  const { FinanceRecurringCommitmentsPanel } = loadSource(
    "components/finance/FinanceRecurringCommitmentsPanel.tsx", {
      react: {
        ...React,
        useState(initial) {
          hookIndex += 1;
          const value = hookIndex === 1 ? data : hookIndex === 3 ? false
            : typeof initial === "function" ? initial() : initial;
          return [value, () => assert.fail("Rendering must not mutate state")];
        },
        useEffect() {}, useCallback: (callback) => callback,
      },
      "react/jsx-runtime": require("react/jsx-runtime"),
      "@/lib/finance/presentation": presentation,
      "@/lib/finance/recurring-presentation": recurringPresentation,
    }
  );
  return renderToStaticMarkup(React.createElement(FinanceRecurringCommitmentsPanel, {
    asOfDate, canEdit: false, onChanged: () => assert.fail("Rendering must not request a write"),
  }));
}

function commitmentTable(html) {
  return html.slice(html.indexOf('min-w-[900px]'));
}

test("end dates are inclusive and active count uses the requested as-of date", async () => {
  for (const [date, activeCount] of [["2026-09-29", 2], ["2026-09-30", 2], ["2026-10-01", 1], ["2026-10-07", 1]]) {
    const body = await register(date);
    assert.equal(body.as_of_date, date);
    assert.equal(body.summary.active_count, activeCount);
    assert.equal(body.commitments.find((row) => row.id === "shift").status, "active");
  }
});

test("draft, paused and archived schedules never count as current active", async () => {
  const rows = [
    ...commitments,
    commitment({ id: "future-end", end_date: "2026-12-31" }),
    ...["draft", "paused", "archived"].map((status) => commitment({ id: status, status, end_date: null })),
  ];
  const body = await register("2026-10-07", rows);
  assert.equal(body.summary.active_count, 2);
  assert.ok(body.commitments.every((row) => row.status !== "archived"));
  assert.equal(body.commitments.length, 5);
});

test("presentation preserves every schedule amount, payment and unpaid pre-cutoff occurrence", async () => {
  const originalRows = structuredClone(commitments);
  const originalPayments = structuredClone(payments);
  const body = await register("2026-10-07");
  const baseline = recurrence.generateRecurringOccurrences({ commitments, payments, asOfDate: "2026-10-07" });
  assert.deepEqual(body.commitments, originalRows);
  assert.deepEqual(body.payments, originalPayments);
  assert.deepEqual(body.occurrences, baseline.map((row) => ({ ...row, linked_invoice_id: null, commitment_version: 1 })));
  assert.deepEqual(body.occurrences.filter((row) => row.commitment_id === "shift").map((row) => row.due_date),
    ["2026-09-04", "2026-09-11", "2026-09-18", "2026-09-25"]);
  const partial = body.occurrences.find((row) => row.commitment_id === "shift" && row.due_date === "2026-09-18");
  assert.equal(partial.paid_minor, 40000);
  assert.equal(partial.remaining_minor, 60000);
  assert.deepEqual(partial.payment_entries, originalPayments[0].payment_entries);
  assert.ok(body.occurrences.some((row) => row.commitment_id === "shift" && row.due_date === "2026-09-25" && row.remaining_minor === 100000));
  assert.ok(body.occurrences.filter((row) => row.commitment_id === "moneytech")
    .every((row) => new Date(`${row.due_date}T00:00:00Z`).getUTCDay() === 5 && row.amount_minor === 170000));
  assert.equal(body.summary.projected_outflow_minor, baseline.reduce((sum, row) => sum + row.remaining_minor, 0));
  assert.deepEqual(commitments, originalRows);
  assert.deepEqual(payments, originalPayments);
});

test("panel renders Moneytech before ended Shift and keeps overdue payments visible", async () => {
  const html = renderPanel(await register("2026-10-07"));
  const table = commitmentTable(html);
  assert.ok(table.indexOf("Current commitments") < table.indexOf("Moneytech"));
  assert.ok(table.indexOf("Moneytech") < table.indexOf("Ended history"));
  assert.ok(table.indexOf("Ended history") < table.indexOf("Shift"));
  assert.match(table, /Ended 30 Sept 2026/);
  assert.match(table.slice(table.indexOf("Shift")), />Ended<\/span>/);
  assert.doesNotMatch(table.slice(table.indexOf("Shift")), />active<\/span>/);
  assert.match(html, /Current active/);
  assert.match(html, /As at 7 Oct 2026/);
  assert.match(html, /recurring-occurrence-shift-2026-09-25/);
  assert.match(html, /overdue, not marked paid/);
});

test("historical and end-day panels keep Shift current and label the scheduled end", async () => {
  for (const date of ["2026-09-25", "2026-09-30"]) {
    const table = commitmentTable(renderPanel(await register(date)));
    assert.match(table, /Current commitments/);
    assert.match(table, /Ends 30 Sept 2026/);
    assert.doesNotMatch(table, /Ended history/);
    assert.match(table, />active<\/span>/);
  }
});

test("panel classification uses the loaded register date while another date is loading", async () => {
  const table = commitmentTable(renderPanel(await register("2026-09-30"), "2026-10-07"));
  assert.match(table, /Ends 30 Sept 2026/);
  assert.doesNotMatch(table, /Ended history/);
});
