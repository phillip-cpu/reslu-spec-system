import assert from "node:assert/strict";
import test from "node:test";
import {
  addCalendarDays,
  plannedClaimTimingState,
  resolveClaimForecastDate,
  resolveTemplateSchedulePhaseId,
  suggestSchedulePhaseId,
} from "./client-claim-schedule.ts";
import type {
  ClientBillingProfile,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../types/client-invoices.ts";

const profile = {
  project_id: "project-1",
  contract_type: "construction",
  contract_label: "Construction contract",
  contract_amount_inc_gst: 150_000,
  due_days: 7,
  contract_reference: "Goldsworthy construction contract",
  contract_signed_at: "2026-07-13",
} as ClientBillingProfile;

const phases: ClientSchedulePhase[] = [
  { id: "demo", name: "Demolition", start_date: "2026-08-10", end_date: "2026-08-20", sort: 1 },
  { id: "first-fix", name: "First Fix", start_date: "2026-08-21", end_date: "2026-09-04", sort: 2 },
];

function stage(patch: Partial<ClientPaymentScheduleItem>): ClientPaymentScheduleItem {
  return {
    id: "claim-1",
    project_id: "project-1",
    label: "Demo",
    percentage: 20,
    amount_inc_gst: 30_000,
    milestone_date: null,
    trigger_type: "schedule_phase",
    schedule_phase_id: "demo",
    sort: 1,
    client_invoice_id: null,
    ...patch,
  };
}

test("contract signing and the live program resolve claim forecast dates", () => {
  assert.equal(
    resolveClaimForecastDate({
      stage: stage({ trigger_type: "contract_signed", schedule_phase_id: null }),
      profile,
      phases,
    }),
    "2026-07-13"
  );
  assert.equal(resolveClaimForecastDate({ stage: stage({}), profile, phases }), "2026-08-20");
  assert.equal(
    resolveClaimForecastDate({
      stage: stage({}),
      profile,
      phases: [{ ...phases[0], end_date: "2026-08-27" }, phases[1]],
    }),
    "2026-08-27"
  );
});

test("payment terms turn a claim date into the expected receipt date", () => {
  assert.equal(addCalendarDays("2026-08-20", 7), "2026-08-27");
  assert.equal(plannedClaimTimingState(null, "2026-08-06"), "needs_link");
  assert.equal(plannedClaimTimingState("2026-08-20", "2026-08-06"), "planned");
  assert.equal(plannedClaimTimingState("2026-08-06", "2026-08-06"), "review");
});

test("Goldsworthy labels suggest only unambiguous schedule phases", () => {
  assert.equal(suggestSchedulePhaseId("Demo", phases), "demo");
  assert.equal(suggestSchedulePhaseId("First fix", phases), "first-fix");
  assert.equal(
    suggestSchedulePhaseId("Demo", [
      phases[0],
      { ...phases[0], id: "demo-2", name: "Demo inspection" },
    ]),
    null
  );
});

test("template milestones use their explicit Timeline anchor before label guessing", () => {
  assert.equal(
    resolveTemplateSchedulePhaseId("First Fix", "Demo", phases),
    "first-fix"
  );
});
