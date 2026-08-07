import assert from "node:assert/strict";
import test from "node:test";
import { buildCompanyClientClaimPortfolio } from "./company-client-claims.ts";
import type {
  ClientBillingProfile,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../../types/client-invoices.ts";

const profile = {
  project_id: "goldsworthy",
  contract_type: "construction",
  contract_label: "Construction contract",
  contract_amount_inc_gst: 150_000,
  due_days: 7,
  contract_reference: "Signed contract",
  contract_signed_at: "2026-07-13",
} as ClientBillingProfile;

const schedule = [
  {
    id: "deposit",
    project_id: "goldsworthy",
    label: "Deposit",
    percentage: 30,
    amount_inc_gst: 45_000,
    milestone_date: null,
    trigger_type: "contract_signed",
    schedule_phase_id: null,
    sort: 0,
    client_invoice_id: "deposit-invoice",
  },
  {
    id: "demo",
    project_id: "goldsworthy",
    label: "Demo",
    percentage: 20,
    amount_inc_gst: 30_000,
    milestone_date: null,
    trigger_type: "schedule_phase",
    schedule_phase_id: "demo-phase",
    sort: 1,
    client_invoice_id: "demo-invoice",
  },
  {
    id: "first-fix",
    project_id: "goldsworthy",
    label: "First fix",
    percentage: 20,
    amount_inc_gst: 30_000,
    milestone_date: null,
    trigger_type: "schedule_phase",
    schedule_phase_id: "first-fix-phase",
    sort: 2,
    client_invoice_id: null,
  },
] as ClientPaymentScheduleItem[];

const phases = [
  { id: "demo-phase", project_id: "goldsworthy", name: "Demo", start_date: "2026-07-20", end_date: "2026-07-24", sort: 0 },
  { id: "first-fix-phase", project_id: "goldsworthy", name: "First fix", start_date: "2026-08-10", end_date: "2026-08-21", sort: 1 },
] as ClientSchedulePhase[];

const invoices = [
  {
    id: "deposit-invoice",
    project_id: "goldsworthy",
    status: "paid",
    issued_at: "2026-07-13T00:00:00.000Z",
    paid_at: "2026-07-14T00:00:00.000Z",
    due_days: 7,
    total_inc_gst: 45_000,
  },
  {
    id: "demo-invoice",
    project_id: "goldsworthy",
    status: "paid",
    issued_at: "2026-07-24T00:00:00.000Z",
    paid_at: "2026-07-30T00:00:00.000Z",
    due_days: 7,
    total_inc_gst: 30_000,
  },
] as ClientInvoice[];

test("saved client claims feed company finance without an activation profile", () => {
  const portfolio = buildCompanyClientClaimPortfolio({
    profiles: [profile],
    schedule,
    phases,
    invoices,
    projectNames: new Map([["goldsworthy", "Goldsworthy Virgo"]]),
  });

  assert.equal(portfolio.summary.projectCount, 1);
  assert.equal(portfolio.summary.claimCount, 3);
  assert.equal(portfolio.summary.contractedMinor, 10_500_000);
  assert.equal(portfolio.summary.issuedMinor, 7_500_000);
  assert.equal(portfolio.summary.paidMinor, 7_500_000);
  assert.equal(portfolio.summary.outstandingMinor, 0);
  assert.equal(portfolio.summary.forecastRemainingMinor, 3_000_000);
  assert.equal(portfolio.contributions[0].sourceTrace?.project_name, "Goldsworthy Virgo");
});
