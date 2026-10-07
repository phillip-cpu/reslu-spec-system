import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import * as baseline from "../../../../lib/finance/baseline.ts";
import * as companyClaims from "../../../../lib/finance/company-client-claims.ts";
import * as constructionCosts from "../../../../lib/finance/construction-cost-eligibility.ts";
import * as liquidity from "../../../../lib/finance/liquidity.ts";
import * as operatingView from "../../../../lib/finance/operating-view.ts";
import * as presentation from "../../../../lib/finance/presentation.ts";
import * as projection from "../../../../lib/finance/projection.ts";
import * as readiness from "../../../../lib/finance/readiness.ts";
import * as recurrence from "../../../../lib/finance/recurrence.ts";
import * as recurringActuals from "../../../../lib/finance/recurring-invoice-actuals.ts";
import * as scenarios from "../../../../lib/finance/scenarios.ts";
import * as scheduleTiming from "../../../../lib/finance/schedule-cost-timing.ts";
import * as supplierActuals from "../../../../lib/finance/supplier-actuals.ts";
import * as xeroActuals from "../../../../lib/finance/xero-actuals.ts";

// Fixture amounts and invoice IDs are synthetic. The previously verified 29/6
// classification is a regression input, not a live read or published financial record.
// Execute the real route and UI with only read-only fixture persistence.
const root = resolve(import.meta.dirname, "../../../..");
const require = createRequire(resolve(root, "package.json"));
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { NextRequest, NextResponse } = require("next/server");
const [fairmont, crouch] = operatingView.NATHAN_RECEIVABLE_CONTACT_IDS;

function loadSource(path, dependencies, globals = {}) {
  const compiled = ts.transpileModule(readFileSync(resolve(root, path), "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const compiledModule = { exports: {} };
  runInNewContext(compiled, {
    module: compiledModule, exports: compiledModule.exports, ...globals,
    require(name) {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected live dependency: ${name}`);
      return dependencies[name];
    },
  }, { filename: path });
  return compiledModule.exports;
}

function invoice(overrides = {}) {
  return {
    xero_invoice_id: "unrelated", invoice_type: "ACCREC", status: "AUTHORISED",
    invoice_number: "FIXTURE-OTHER", contact_id: "other-contact", contact_name: "Fairmont Homes",
    invoice_date: "2026-09-30", due_date: "2026-10-09", total: "500.00",
    amount_paid: "0.00", amount_credited: "0.00", ...overrides,
  };
}

function fixture() {
  const outstanding = [15000, 17500, 12500, 22500, 8000, 17275];
  const assigned = Array.from({ length: 29 }, (_, index) => {
    const owed = outstanding[index] ?? 0;
    const paid = index === 0 ? 50000 : index < 6 ? 0 : 10000;
    const credited = index === 1 ? 10000 : 0;
    return invoice({
      xero_invoice_id: `nathan-${index}`, invoice_number: `FIXTURE-N-${index}`,
      contact_id: index % 2 ? crouch : fairmont,
      contact_name: index % 2 ? "Crouch Construction" : "Fairmont Homes",
      status: index < 6 ? "AUTHORISED" : "PAID",
      total: ((owed + paid + credited) / 100).toFixed(2),
      amount_paid: (paid / 100).toFixed(2), amount_credited: (credited / 100).toFixed(2),
    });
  });
  const invoices = [
    ...assigned,
    invoice(), // Same display name but a different contact UUID must remain.
    invoice({ xero_invoice_id: "similar", contact_id: "unrelated-uuid", contact_name: "Crouch Construction Pty Ltd" }),
    invoice({ xero_invoice_id: "missing-contact", contact_id: null, contact_name: "Fairmont Homes" }),
    invoice({ xero_invoice_id: "shared-bill", invoice_type: "ACCPAY", contact_id: fairmont,
      total: "1100.00", amount_paid: "220.00", amount_credited: "110.00" }),
  ];
  const payments = invoices.filter((row) => Number(row.amount_paid) > 0).map((row) => ({
    xero_invoice_id: row.xero_invoice_id, payment_date: "2026-09-30", status: "AUTHORISED",
  }));
  return { invoices, payments };
}

async function cockpit(scope, input = fixture(), openingCash) {
  const reads = [];
  const tables = {
    xero_connections: { id: "fixture-connection", tenant_name: "Fixture company",
      last_sync_completed_at: "2026-10-06T00:00:00Z", last_sync_error: null },
    xero_cash_snapshots: { cash_balance: "10000.00", credit_balance: "0.00",
      as_of_date: "2026-10-06", raw_json: {} },
    xero_invoices: input.invoices, xero_payments: input.payments,
    xero_bank_accounts: [{ id: "fixture-card", name: "Shared credit card", bank_account_type: "CREDITCARD",
      account_class: "LIABILITY", current_balance: "-2000.00", balance_as_of: "2026-10-06", balance_source: "bank_summary" }],
    project_finance_profiles: [], finance_recurring_commitments: [],
    finance_credit_facilities: [{ facility_type: "credit_card", credit_limit_minor: 1000000, xero_bank_account_id: "fixture-card" }],
    finance_recurring_occurrence_payments: [], invoices: [], client_billing_profiles: [],
  };
  const client = {
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected fixture table: ${table}`);
      const query = {};
      for (const method of ["select", "eq", "lte", "order", "limit", "maybeSingle", "in", "is", "neq"]) {
        query[method] = (...args) => { reads.push({ table, method, args }); return query; };
      }
      query.then = (fulfilled, rejected) => {
        const data = tables[table];
        return Promise.resolve({ data, error: null, count: Array.isArray(data) ? data.length : 1 })
          .then(fulfilled, rejected);
      };
      // No writes, RPC, sync, auth credentials or network dependencies exist.
      return query;
    },
  };
  const { GET } = loadSource("app/api/finance/cockpit/route.ts", {
    "next/server": { NextRequest, NextResponse },
    "@/lib/auth": { getUserRole: async () => ({ role: "owner" }) },
    "@/lib/finance/feature-flags": { financeFoundationEnabled: () => true, financeShadowProjectionEnabled: () => true },
    "@/lib/finance/permissions": { hasFinanceCapability: async (_client, capability) => ({ allowed: capability === "finance.view_company", error: null }) },
    "@/lib/finance/projection": projection, "@/lib/finance/operating-view": operatingView,
    "@/lib/finance/baseline": baseline, "@/lib/finance/company-client-claims": companyClaims,
    "@/lib/finance/recurrence": recurrence, "@/lib/finance/recurring-invoice-actuals": recurringActuals,
    "@/lib/finance/readiness": readiness, "@/lib/finance/schedule-cost-timing": scheduleTiming,
    "@/lib/finance/ffe-timing-server": { loadProjectFfeForecastTiming: () => assert.fail("No project fixture should load timing") },
    "@/lib/finance/construction-cost-eligibility": constructionCosts,
    "@/lib/finance/liquidity": liquidity, "@/lib/finance/scenarios": scenarios,
    "@/lib/finance/supplier-actuals": supplierActuals, "@/lib/finance/xero-actuals": xeroActuals,
    "@/lib/supabase/server": { createClient: async () => client, createServiceRoleClient: () => client },
    "@/lib/xero/access": { hasXeroAccess: () => true },
    "@/lib/xero/bank-summary": { calculateBankSummaryBalance: () => assert.fail("No report fixture should recalculate bank cash") },
  });
  const params = new URLSearchParams({ as_of_date: "2026-10-07" });
  if (scope !== undefined) params.set("view_scope", scope);
  if (openingCash !== undefined) params.set("opening_cash_minor", String(openingCash));
  const response = await GET(new NextRequest(`https://example.test/api/finance/cockpit?${params}`));
  return { status: response.status, body: await response.json(), reads };
}

function ui(data, fetchFixture = () => assert.fail("Rendering must not fetch")) {
  let hookIndex = 0;
  const { FinanceCockpit } = loadSource("components/finance/FinanceCockpit.tsx", {
    react: {
      ...React,
      useState(initial) {
        hookIndex += 1;
        const value = hookIndex === 1 ? data : hookIndex === 2 ? false
          : hookIndex === 4 ? "2026-10-07" : hookIndex === 6 ? data?.operating_view.scope ?? initial
          : typeof initial === "function" ? initial() : initial;
        return [value, () => {}];
      },
      useEffect() {}, useCallback: (callback) => callback, useMemo: (callback) => callback(),
    },
    "react/jsx-runtime": require("react/jsx-runtime"),
    "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children) },
    "./FinanceCashCurve": { FinanceCashCurve: () => null },
    "./FinanceRecurringCommitmentsPanel": { FinanceRecurringCommitmentsPanel: () => null },
    "./FinanceCompanyInvoicesPanel": { FinanceCompanyInvoicesPanel: () => null },
    "@/lib/finance/presentation": presentation,
  }, { URLSearchParams, fetch: fetchFixture });
  return FinanceCockpit();
}

function findElement(element, type) {
  if (!element || typeof element !== "object") return null;
  if (element.type === type) return element;
  return React.Children.toArray(element.props?.children).map((child) => findElement(child, type)).find(Boolean) ?? null;
}

test("Phillip view excludes the two exact contact IDs: 29 receivables, six outstanding", () => {
  const input = fixture();
  const before = structuredClone(input);
  const selected = operatingView.selectOperatingViewInvoices(input.invoices, "phillip");
  assert.deepEqual(selected.summary, { scope: "phillip", excluded_receivable_count: 29,
    excluded_outstanding_count: 6, excluded_outstanding_minor: 92775, opening_cash_scope: "company_pooled" });
  assert.deepEqual(selected.invoices.map((row) => row.xero_invoice_id), ["unrelated", "similar", "missing-contact", "shared-bill"]);
  assert.deepEqual(input, before);
});

test("future invoices use contact UUIDs even if renamed; names and payables never classify ownership", () => {
  const rows = [
    invoice({ xero_invoice_id: "future", contact_id: fairmont.toUpperCase(), contact_name: "Renamed contact", due_date: "2026-11-06" }),
    invoice({ xero_invoice_id: "future-crouch", contact_id: crouch, contact_name: "Another new name", due_date: "2026-11-13" }),
    invoice(), invoice({ xero_invoice_id: "similar", contact_name: "Crouch Construction" }),
    invoice({ xero_invoice_id: "bill", invoice_type: "ACCPAY", contact_id: crouch }),
  ];
  const selected = operatingView.selectOperatingViewInvoices(rows, "phillip");
  assert.deepEqual(selected.invoices.map((row) => row.xero_invoice_id), ["unrelated", "similar", "bill"]);
  assert.equal(selected.summary.excluded_outstanding_count, 2);
  assert.deepEqual(operatingView.selectOperatingViewInvoices(rows, "company").invoices, rows);
});

test("real GET filters before reconciliation and removes the same outstanding inflows from both forecasts", async () => {
  const input = fixture();
  const before = structuredClone(input);
  const company = await cockpit("company", input);
  const phillip = await cockpit("phillip", input);
  assert.equal(company.status, 200); assert.equal(phillip.status, 200);
  assert.equal(phillip.body.operating_view.excluded_outstanding_minor, 92775);
  for (const key of ["cash_projection", "planning_projection", "projection"]) {
    assert.equal(company.body[key].totalInflowMinor - phillip.body[key].totalInflowMinor, 92775);
    assert.equal(phillip.body[key].totalInflowMinor, 150000);
    assert.equal(phillip.body[key].totalOutflowMinor, 77000);
    assert.ok(phillip.body[key].effectiveContributions.every((item) => !String(item.sourceTrace.source_record_id).startsWith("nathan-")));
    assert.deepEqual(phillip.body[key].effectiveContributions,
      company.body[key].effectiveContributions.filter((item) => !String(item.sourceTrace.source_record_id).startsWith("nathan-")));
    assert.equal(phillip.body[key].openingCashMinor, company.body[key].openingCashMinor);
  }
  const selectedColumns = phillip.reads.find((read) => read.table === "xero_invoices" && read.method === "select").args[0].split(",");
  assert.ok(selectedColumns.includes("contact_id"));
  assert.equal(company.body.source_status.xero_invoice_actuals - phillip.body.source_status.xero_invoice_actuals, 29);
  assert.deepEqual(input, before);
});

test("payments, credited amounts, shared payables and credit liquidity retain company scope", async () => {
  const input = fixture();
  const company = (await cockpit("company", input)).body;
  const phillip = (await cockpit("phillip", input)).body;
  assert.equal(phillip.source_status.xero_payment_records, input.payments.length);
  assert.equal(phillip.source_status.xero_payment_records, company.source_status.xero_payment_records);
  for (const key of ["bank_cash_minor", "credit_limit_minor", "credit_drawn_minor", "available_credit_minor", "available_liquidity_minor"]) {
    assert.equal(phillip.liquidity_summary[key], company.liquidity_summary[key]);
  }
  assert.equal(phillip.liquidity_summary.credit_drawn_minor, 200000);
  assert.equal(phillip.liquidity_summary.available_credit_minor, 800000);
  const payable = phillip.cash_projection.effectiveContributions.filter((item) => item.sourceTrace.source_record_id === "shared-bill");
  assert.deepEqual(payable, company.cash_projection.effectiveContributions.filter((item) => item.sourceTrace.source_record_id === "shared-bill"));
  assert.equal(payable.reduce((sum, item) => sum + item.amountMinor, 0), 99000);
  assert.deepEqual(input.invoices[0], fixture().invoices[0]); // Partial payment preserved.
  assert.deepEqual(input.invoices[6], fixture().invoices[6]); // Fully paid historical invoice preserved.
  assert.deepEqual(input.invoices[1], fixture().invoices[1]); // Credit and gross source amount preserved.
});

test("company mode remains the API default and switching back restores identical projections", async () => {
  const input = fixture();
  const initial = (await cockpit(undefined, input)).body;
  await cockpit("phillip", input);
  const restored = (await cockpit("company", input)).body;
  assert.equal(initial.operating_view.scope, "company");
  assert.equal(initial.operating_view.excluded_receivable_count, 0);
  assert.equal(restored.operating_view.excluded_outstanding_minor, 0);
  for (const key of ["projection", "cash_projection", "planning_projection", "liquidity_summary"]) {
    assert.deepEqual(restored[key], initial[key]);
  }
  const preview = (await cockpit("phillip", input, 123456)).body;
  assert.equal(preview.cash_projection.openingCashMinor, 123456);
  assert.equal(preview.source_status.opening_cash, "request_preview");
  assert.equal(preview.operating_view.opening_cash_scope, "company_pooled");
});

test("invalid ownership scope is rejected before any financial read", async () => {
  const response = await cockpit("nathan");
  assert.equal(response.status, 400);
  assert.deepEqual(response.reads, []);
});

test("UI labels the invoice-only view and pooled cash limitation, with a company-wide option", async () => {
  const phillip = (await cockpit("phillip")).body;
  const html = renderToStaticMarkup(ui(phillip));
  assert.match(html, /Invoice view/);
  assert.match(html, /value="phillip" selected=""/);
  assert.match(html, /Company-wide/);
  assert.match(html, /6 outstanding, \$927\.75/);
  assert.match(html, /both cash and planning timelines/);
  assert.match(html, /Shared payables and credit remain included/);
  assert.match(html, /Opening cash uses the company pool/);
  assert.match(html, /does not isolate a bank account/);
  const companyHtml = renderToStaticMarkup(ui((await cockpit("company")).body));
  assert.match(companyHtml, /value="company" selected=""/);
  assert.match(companyHtml, /Company-wide view includes all company receivables/);
  assert.doesNotMatch(companyHtml, /6 outstanding/);
});

test("initial UI request and switching views use read-only GET with explicit scope", async () => {
  const requests = [];
  const data = (await cockpit("company")).body;
  const fetchFixture = async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => data };
  };
  const initial = ui(null, fetchFixture);
  findElement(initial, "form").props.onSubmit({ preventDefault() {} });
  assert.equal(new URL(requests[0].url, "https://example.test").searchParams.get("view_scope"), "phillip");
  const loaded = ui((await cockpit("phillip")).body, fetchFixture);
  findElement(loaded, "select").props.onChange({ target: { value: "company" } });
  assert.equal(new URL(requests[1].url, "https://example.test").searchParams.get("view_scope"), "company");
  for (const request of requests) {
    assert.equal(request.options.cache, "no-store");
    assert.equal(request.options.method, undefined); // Browser default GET.
    assert.ok(request.url.startsWith("/api/finance/cockpit?"));
  }
});
