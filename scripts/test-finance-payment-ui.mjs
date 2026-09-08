/**
 * Runs the real Finance React components against synthetic API fixtures in jsdom.
 * No credentials or live API requests are used. Install esbuild@0.25.10 and
 * jsdom@26.1.0 in a temporary folder, then run:
 * FINANCE_UI_TEST_DEPS=/absolute/temp/folder node scripts/test-finance-payment-ui.mjs
 * The temporary install does not change the application's package files.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dependencyRequire = createRequire(join(process.env.FINANCE_UI_TEST_DEPS || repo, "package.json"));
const { build, stop } = dependencyRequire("esbuild");
const { JSDOM } = dependencyRequire("jsdom");
const scratch = await mkdtemp(join(tmpdir(), "reslu-finance-ui-bundle-"));
const bundle = join(scratch, "components.cjs");
const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://finance-test.invalid/finance", pretendToBeVisual: true });
const { window } = dom;
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLSelectElement", "Event", "MouseEvent", "CustomEvent", "MutationObserver"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? window : window[name] });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// React's bundled act helper falls back to MessageChannel. Node keeps those
// ports alive, so retain the test-created channels for explicit teardown.
const messageChannels = [];
const NativeMessageChannel = globalThis.MessageChannel;
globalThis.MessageChannel = class extends NativeMessageChannel {
  constructor() { super(); messageChannels.push(this); }
};
const scrolled = [];
window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this.id); };
window.scrollTo = () => {};
window.prompt = () => "Correct duplicate bank reference in synthetic test";
let root;

try {
  await build({
    stdin: {
      contents: 'export { act, createElement } from "react"; export { createRoot } from "react-dom/client"; export { FinanceCockpit } from "./components/finance/FinanceCockpit"; export { FinanceCompanyInvoicesPanel } from "./components/finance/FinanceCompanyInvoicesPanel"; export { calculateShadowProjection } from "./lib/finance/projection";',
      resolveDir: repo, sourcefile: "finance-ui-test-entry.tsx", loader: "tsx",
    },
    outfile: bundle, bundle: true, platform: "node", format: "cjs", jsx: "automatic",
    tsconfig: join(repo, "tsconfig.json"), define: { "process.env.NODE_ENV": '"development"' },
    plugins: [{ name: "next-link-test-stand-in", setup(builder) {
      builder.onResolve({ filter: /^next\/link$/ }, () => ({ path: "next-link", namespace: "test-link" }));
      builder.onLoad({ filter: /.*/, namespace: "test-link" }, () => ({
        contents: 'import { createElement } from "react"; export default function Link({href,children,...props}) { return createElement("a", {...props,href},children); }',
        resolveDir: repo, loader: "js",
      }));
    } }],
  });
  const { act, createElement, createRoot, FinanceCockpit, FinanceCompanyInvoicesPanel, calculateShadowProjection } = createRequire(import.meta.url)(bundle);
  const testDate = "2026-09-08";
  const billId = "test-company-rent";
  let canEditPayment = true;
  let invoice = {
    id: billId, expense_scope: "company", supplier: "Synthetic landlord", invoice_number: "TEST-RENT",
    invoice_date: "2026-08-28", due_date: "2026-09-01", currency_code: "AUD",
    amount_ex_gst: 1000, gst: 100, total: 1100, status: "approved", payment_status: "unpaid", amount_paid: 0, paid_at: null,
    company_expense_category: "rent", recurring_commitment_id: "test-rent", recurring_due_date: null,
    finance_recurring_commitments: { id: "test-rent", name: "Synthetic rent", first_due_date: "2026-08-13", frequency: "monthly", end_date: null },
  };
  const commitment = {
    id: "test-software", name: "Synthetic software", category: "software", supplier_or_payee: "Test software vendor",
    amount_minor: 8000, frequency: "monthly", first_due_date: "2026-09-10", end_date: null,
    gst_treatment: "inclusive", annual_escalation_bps: 0, confidence: "confirmed", status: "active", version: 3, notes: null,
  };
  let occurrence = {
    commitment_id: commitment.id, name: commitment.name, due_date: "2026-09-10", amount_minor: 8000,
    paid_minor: 0, remaining_minor: 8000, payment_version: 0, paid_on: null, payment_entries: [],
    status: "unpaid", linked_invoice_id: null, commitment_version: 3,
  };
  const calls = [];
  function cockpit() {
    const cashContributions = [{
      contributionKey: `supplier:${billId}`, direction: "outflow", description: "Synthetic rent invoice",
      plannedMinor: 0, actualAccruedMinor: 110000, actualPaidMinor: invoice.amount_paid * 100,
      actualPaidDate: invoice.paid_at, actualDueDate: invoice.due_date, confidence: "confirmed",
      sourceTrace: { source_type: "supplier_invoice_allocation", supplier_invoice_id: billId, supplier: invoice.supplier },
    }, {
      contributionKey: "recurring:test-software:2026-09-10", direction: "outflow", description: commitment.name,
      plannedMinor: occurrence.remaining_minor, plannedDate: occurrence.due_date, confidence: "confirmed",
      sourceTrace: { source: "recurring_commitment", recurring_commitment_id: commitment.id, due_date: occurrence.due_date },
    }];
    const projectAllowance = { contributionKey: "estimate:synthetic", direction: "outflow", description: "Synthetic project allowance",
      plannedMinor: 25000, plannedDate: "2026-09-11", sourceTrace: { source_type: "estimate_cost_line", project_id: "test-project" } };
    const project = (contributions) => calculateShadowProjection({ asOfDate: testDate, openingCashAsOfDate: "2026-09-07", openingCashMinor: 500000, contributions, weeklyPeriods: 2 });
    const cash = project(cashContributions);
    return {
      can_edit_forecast: true, projects: [], projection: cash, cash_projection: cash,
      planning_projection: project([...cashContributions, projectAllowance]),
      allowance_summary: { total_minor: 25000 },
      client_claims_summary: { paid_minor: 0, outstanding_minor: 0, forecast_remaining_minor: 0 },
      counts: { connected_client_claims: 0, connected_projects: 0, active_recurring_commitments: 2 },
      source_status: {
        xero: "healthy", payment_coverage: "no_payment_records", payment_conflicts: 0,
        recurring_bills_needing_link: invoice.recurring_due_date ? 0 : 1, unresolved_currency_bills: 0,
        opening_cash: "xero_bank_summary", xero_cash_as_of: "2026-09-07", calculated_at: "2026-09-08T00:00:00Z",
        xero_invoice_actuals: 0, xero_matched_supplier_bills: 0, xero_matched_invoices: 0, xero_payment_records: 0,
      },
    };
  }
  function recurringRegister() {
    return {
      commitments: [commitment], occurrences: [occurrence, {
        ...occurrence, commitment_id: "test-rent", name: "Synthetic rent", due_date: "2026-09-13",
        linked_invoice_id: billId, amount_minor: 110000, remaining_minor: 110000,
      }], summary: { active_count: 2, projected_outflow_minor: occurrence.remaining_minor, next_due_date: occurrence.due_date, linked_occurrence_count: 1 },
    };
  }
  globalThis.fetch = async (resource, options = {}) => {
    assert.equal(typeof resource, "string");
    assert(resource.startsWith("/api/"), "Test forbids absolute or external API requests");
    const url = new URL(resource, "http://finance-test.invalid");
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ pathname: url.pathname, method, body });
    let result;
    if (url.pathname === "/api/finance/cockpit" && method === "GET") result = cockpit();
    else if (url.pathname === "/api/finance/company-invoices" && method === "GET") result = { invoices: [invoice], can_edit_payment: canEditPayment };
    else if (url.pathname === `/api/invoices/${billId}` && method === "PATCH") {
      invoice = { ...invoice, ...body };
      result = { invoice };
    } else if (url.pathname === "/api/finance/recurring-payments") {
      if (method === "POST") occurrence = { ...occurrence, paid_minor: occurrence.paid_minor + body.amount_minor,
        remaining_minor: occurrence.remaining_minor - body.amount_minor, payment_version: occurrence.payment_version + 1,
        paid_on: body.paid_on, status: "part_paid", payment_entries: [...occurrence.payment_entries, { amount_minor: body.amount_minor, paid_on: body.paid_on }] };
      else if (method === "DELETE") occurrence = { ...occurrence, paid_minor: 0, remaining_minor: 8000,
        payment_version: occurrence.payment_version + 1, paid_on: null, status: "unpaid", payment_entries: [] };
      else assert.equal(method, "GET");
      result = recurringRegister();
    } else assert.fail(`Unexpected synthetic request: ${method} ${url.pathname}`);
    return { ok: true, status: 200, json: async () => structuredClone(result) };
  };
  window.fetch = globalThis.fetch;
  const content = () => window.document.body.textContent;
  const button = (text) => {
    const found = [...window.document.querySelectorAll("button")].find((node) => node.textContent.trim() === text);
    assert(found, `Missing button: ${text}`);
    return found;
  };
  const field = (scope, text) => {
    const label = [...scope.querySelectorAll("label")].find((node) => node.textContent.trim().startsWith(text));
    assert(label, `Missing field: ${text}`);
    return label.querySelector("input, select, textarea");
  };
  const click = async (node) => act(async () => node.dispatchEvent(new window.MouseEvent("click", { bubbles: true })));
  const setValue = async (node, value) => act(async () => {
    const prototype = node.tagName === "SELECT" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(node, value);
    node.dispatchEvent(new window.Event(node.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
    node.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
  const submit = async (form) => act(async () => form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
  async function until(predicate, description) {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
      if (predicate()) return;
    }
    assert.fail(`Timed out: ${description}\n${content().slice(-2500)}`);
  }
  const forecastLoads = () => calls.filter((call) => call.pathname === "/api/finance/cockpit").length;
  let checks = 0;
  async function check(name, test) { await test(); checks += 1; console.log(`PASS ${name}`); }
  root = createRoot(window.document.getElementById("root"));
  await act(async () => root.render(createElement(FinanceCockpit)));
  await until(() => content().includes("Synthetic rent invoice"), "initial finance data");
  await setValue(field(window.document, "As of"), testDate);
  await click(button("Refresh"));

  await check("cash/planning switch uses distinct project allowance coverage", async () => {
    assert(!content().includes("Synthetic project allowance"));
    await click(button("Include project estimates"));
    assert.equal(button("Include project estimates").getAttribute("aria-pressed"), "true");
    assert(content().includes("Synthetic project allowance"));
    await click(button("Committed cash"));
    assert(!content().includes("Synthetic project allowance"));
  });
  await check("zero Xero payments produce an explicit reconciliation warning", async () => {
    assert(content().includes("Bank balance synced, but Xero has supplied no payment records"));
    assert(content().includes("Bank synced · payments not reconciled"));
  });
  await check("company outflow opens, focuses and highlights its actual invoice", async () => {
    await click(window.document.querySelector('[aria-label="Review bill / record payment: Synthetic rent invoice"]'));
    await until(() => window.document.querySelector('form[aria-label="Payment for Synthetic landlord invoice TEST-RENT"]'), "focused invoice editor");
    assert.equal(window.document.querySelector('[role="tab"][aria-selected="true"]').textContent, "Company bills");
    assert(scrolled.includes(`company-invoice-${billId}`));
    assert.equal(window.document.activeElement.id, `company-invoice-${billId}`);
    assert(window.document.getElementById(`company-invoice-${billId}`).className.includes("bg-amber-50"));
  });
  await check("payment requires actual date, saves the invoice and refreshes cockpit", async () => {
    const form = window.document.querySelector('form[aria-label="Payment for Synthetic landlord invoice TEST-RENT"]');
    assert.equal(field(form, "Payment date").value, "");
    await setValue(field(form, "Payment status"), "paid");
    await submit(form);
    assert.equal(calls.filter((call) => call.method === "PATCH").length, 0);
    assert(content().includes("actual payment date"));
    await setValue(field(form, "Payment date"), "2026-09-04");
    await setValue(field(form, "Recurring payment due date"), "2026-09-13");
    const loads = forecastLoads();
    await submit(form);
    await until(() => forecastLoads() > loads && content().includes("Payment saved for Synthetic landlord"), "payment save plus forecast refresh");
    assert.deepEqual(calls.find((call) => call.method === "PATCH").body, {
      due_date: "2026-09-01", payment_status: "paid", amount_paid: 1100,
      paid_at: "2026-09-04", recurring_due_date: "2026-09-13",
    });
    await click(button("Cash timeline"));
    assert(!content().includes("Synthetic rent invoice"), "Historic payment must leave the outflow list after refresh");
  });
  await check("recurring outflow focuses the occurrence, records an increment and refreshes", async () => {
    await click(window.document.querySelector('[aria-label="Review / record payment: Synthetic software"]'));
    await until(() => window.document.getElementById("recurring-occurrence-test-software-2026-09-10"), "recurring occurrence");
    await until(() => scrolled.includes("recurring-occurrence-test-software-2026-09-10"), "recurring focus");
    await click(button("Record payment"));
    const amount = field(window.document, "Amount paid this time");
    const form = amount.closest("form");
    await setValue(amount, "40.00");
    await setValue(field(form, "Actual payment date"), "2026-09-04");
    await setValue(field(form, "Reference / note"), "Synthetic bank reference");
    const loads = forecastLoads();
    await submit(form);
    await until(() => forecastLoads() > loads && content().includes("Payment recorded for Synthetic software"), "recurring payment save");
    assert.deepEqual(calls.find((call) => call.method === "POST").body, {
      commitment_id: "test-software", due_date: "2026-09-10", amount_minor: 4000,
      paid_on: "2026-09-04", reason: "Synthetic bank reference", expected_version: 0, expected_commitment_version: 3,
    });
    assert.equal(occurrence.remaining_minor, 4000);
  });
  await check("undo records an explicit correction and refreshes the remaining amount", async () => {
    const loads = forecastLoads();
    await click(button("Undo last payment record"));
    await until(() => forecastLoads() > loads && content().includes("was undone"), "payment undo");
    assert.deepEqual(calls.find((call) => call.method === "DELETE").body, {
      commitment_id: "test-software", due_date: "2026-09-10", expected_version: 1,
      expected_commitment_version: 3, reason: "Correct duplicate bank reference in synthetic test",
    });
    assert.equal(occurrence.remaining_minor, 8000);
  });
  await check("linked occurrence routes back to its company bill instead of a second payment form", async () => {
    await setValue(field(window.document, "Filter outgoing"), "");
    await click(button("Managed on company bill"));
    await until(() => window.document.querySelector('form[aria-label="Payment for Synthetic landlord invoice TEST-RENT"]'), "linked company bill editor");
    assert.equal(window.document.activeElement.id, `company-invoice-${billId}`);
  });
  await check("non-admin cannot open payment editing even with a focused approved bill", async () => {
    canEditPayment = false;
    await act(async () => root.render(createElement(FinanceCompanyInvoicesPanel, { focusInvoiceId: billId })));
    await until(() => content().includes("TEST-RENT"), "view-only bill list");
    assert(!window.document.querySelector("form"));
    assert(![...window.document.querySelectorAll("button")].some((node) => /Record payment|Edit payment/.test(node.textContent)));
  });
  console.log(`${checks} Finance interaction checks passed. Every API call used synthetic local fixtures.`);
} finally {
  if (root) {
    const { act } = createRequire(import.meta.url)(bundle);
    await act(async () => root.unmount());
  }
  dom.window.close();
  for (const channel of messageChannels) { channel.port1.close(); channel.port2.close(); }
  globalThis.MessageChannel = NativeMessageChannel;
  stop();
  await rm(scratch, { recursive: true, force: true });
}
