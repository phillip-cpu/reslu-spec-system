import assert from "node:assert/strict";
import test from "node:test";
import { buildClientClaimContributions } from "./client-claims.ts";
import type {
  ClientBillingProfile,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../../types/client-invoices.ts";

const profile = {
  project_id: "project-1",
  contract_type: "construction",
  contract_label: "Construction contract",
  contract_amount_inc_gst: 150_000,
  due_days: 7,
  contract_reference: "Goldsworthy construction contract",
  contract_signed_at: "2026-07-13",
} as ClientBillingProfile;

const schedule = [{
  id: "demo-claim",
  project_id: "project-1",
  label: "Demo",
  percentage: 20,
  amount_inc_gst: 30_000,
  milestone_date: null,
  trigger_type: "schedule_phase",
  schedule_phase_id: "demo-phase",
  sort: 1,
  client_invoice_id: null,
}] as ClientPaymentScheduleItem[];

const phases = [{
  id: "demo-phase",
  name: "Demo",
  start_date: "2026-08-10",
  end_date: "2026-08-20",
  sort: 1,
}] as ClientSchedulePhase[];

test("a planned client claim enters cash on the program date plus payment terms", () => {
  const [claim] = buildClientClaimContributions({
    projectId: "project-1",
    profile,
    schedule,
    phases,
    invoices: [],
  });
  assert.equal(claim.direction, "inflow");
  assert.equal(claim.plannedMinor, 3_000_000);
  assert.equal(claim.plannedDate, "2026-08-27");
  assert.equal(claim.actualAccruedMinor, 0);
  assert.equal(claim.sourceTrace?.schedule_phase_id, "demo-phase");
});

test("an issued invoice replaces forecast timing with invoice terms", () => {
  const invoices = [{
    id: "invoice-1",
    status: "sent",
    issued_at: "2026-08-22T00:00:00.000Z",
    paid_at: null,
    due_days: 7,
    total_inc_gst: 30_000,
  }] as ClientInvoice[];
  const [claim] = buildClientClaimContributions({
    projectId: "project-1",
    profile,
    schedule: [{ ...schedule[0], client_invoice_id: "invoice-1" }],
    phases,
    invoices,
  });
  assert.equal(claim.actualAccruedMinor, 3_000_000);
  assert.equal(claim.actualDueDate, "2026-08-29");
  assert.equal(claim.confidence, "high");
});

test("a paid invoice becomes confirmed actual cash", () => {
  const invoices = [{
    id: "invoice-1",
    status: "paid",
    issued_at: "2026-08-22T00:00:00.000Z",
    paid_at: "2026-08-28T00:00:00.000Z",
    due_days: 7,
    total_inc_gst: 30_000,
  }] as ClientInvoice[];
  const [claim] = buildClientClaimContributions({
    projectId: "project-1",
    profile,
    schedule: [{ ...schedule[0], client_invoice_id: "invoice-1" }],
    phases,
    invoices,
  });
  assert.equal(claim.actualPaidMinor, 3_000_000);
  assert.equal(claim.actualPaidDate, "2026-08-28");
  assert.equal(claim.confidence, "confirmed");
});

test("a variation package adds its own claim and uses its own approval date and terms", () => {
  const [claim] = buildClientClaimContributions({
    projectId: "project-1",
    profile,
    schedule: [{
      ...schedule[0],
      id: "variation-claim",
      label: "Variation completion",
      amount_inc_gst: 22_000,
      trigger_type: "contract_signed",
      schedule_phase_id: null,
      contract_variation_id: "variation-1",
    }],
    phases,
    invoices: [],
    contractVariations: [{
      id: "variation-1",
      project_id: "project-1",
      label: "Radio Athens · Variation 01",
      amount_inc_gst: 22_000,
      due_days: 14,
      reference: "VO-01",
      approved_at: "2026-08-12",
      status: "active",
    }],
  });
  assert.equal(claim.plannedMinor, 2_200_000);
  assert.equal(claim.plannedDate, "2026-08-26");
  assert.equal(claim.description, "Client claim — Radio Athens · Variation 01 — Variation completion");
  assert.equal(claim.sourceTrace?.contract_variation_id, "variation-1");
});
