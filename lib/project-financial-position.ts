import { GST_RATE, roundMoney } from "./estimate.ts";

export const FINANCIAL_SUMMARY_CHANGED_EVENT = "reslu:project-finances-changed";

export type FinancialPositionStatus =
  | "needs_setup"
  | "at_risk"
  | "costs_ahead"
  | "on_track"
  | "billing_ahead";

interface SupplierInvoiceInput {
  status: string;
  amount_ex_gst: number | null;
  total: number | null;
}

interface ClientInvoiceInput {
  status: string;
  subtotal_ex_gst: number | null;
  total_inc_gst: number | null;
}

export interface ProjectFinancialPositionInput {
  supplierInvoices: SupplierInvoiceInput[];
  clientInvoices: ClientInvoiceInput[];
  originalContractIncGst: number | null;
  approvedVariationsExGst: number;
  plannedCostExGst: number;
  /**
   * False for design/quoting engagements where the prospective build
   * estimate is intentionally outside this contract's financial position.
   * Defaults to true for backwards compatibility with construction jobs.
   */
  costPlanRequired?: boolean;
}

export interface FinancialTally {
  count: number;
  total_ex_gst: number;
  total_inc_gst: number;
}

export interface ProjectFinancialPosition {
  supplier_approved: FinancialTally;
  client_issued: FinancialTally;
  client_paid: FinancialTally;
  client_outstanding: FinancialTally;
  client_drafts: FinancialTally;
  original_contract_inc_gst: number;
  approved_variations_inc_gst: number;
  adjusted_contract_ex_gst: number;
  adjusted_contract_inc_gst: number;
  planned_cost_ex_gst: number;
  forecast_cost_ex_gst: number;
  forecast_margin_ex_gst: number;
  forecast_margin_pct: number | null;
  current_recorded_position_ex_gst: number;
  billing_progress_pct: number | null;
  cost_progress_pct: number | null;
  progress_gap_points: number | null;
  contract_configured: boolean;
  cost_plan_configured: boolean;
  cost_plan_required: boolean;
  status: FinancialPositionStatus;
  story: string;
}

function numberOrZero(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function tally<T>(
  rows: T[],
  include: (row: T) => boolean,
  exGst: (row: T) => number | null,
  incGst: (row: T) => number | null
): FinancialTally {
  const included = rows.filter(include);
  return {
    count: included.length,
    total_ex_gst: roundMoney(
      included.reduce((sum, row) => sum + numberOrZero(exGst(row)), 0)
    ),
    total_inc_gst: roundMoney(
      included.reduce((sum, row) => sum + numberOrZero(incGst(row)), 0)
    ),
  };
}

function roundPercent(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

/**
 * Produces the project-level financial story without conflating three
 * different things:
 *
 * - approved supplier invoices = recorded project cost;
 * - issued client invoices = billed revenue (not necessarily cash);
 * - paid client invoices = recorded client receipts.
 *
 * Forecast cost is the larger of the current cost plan and approved
 * supplier costs. That keeps the plan as the expected whole-job cost,
 * while immediately surfacing an overrun once approved costs exceed it.
 */
export function calculateProjectFinancialPosition(
  input: ProjectFinancialPositionInput
): ProjectFinancialPosition {
  const supplierApproved = tally(
    input.supplierInvoices,
    (invoice) => invoice.status === "approved",
    (invoice) => invoice.amount_ex_gst,
    (invoice) => invoice.total
  );
  const clientIssued = tally(
    input.clientInvoices,
    (invoice) => invoice.status === "sent" || invoice.status === "paid",
    (invoice) => invoice.subtotal_ex_gst,
    (invoice) => invoice.total_inc_gst
  );
  const clientPaid = tally(
    input.clientInvoices,
    (invoice) => invoice.status === "paid",
    (invoice) => invoice.subtotal_ex_gst,
    (invoice) => invoice.total_inc_gst
  );
  const clientOutstanding = tally(
    input.clientInvoices,
    (invoice) => invoice.status === "sent",
    (invoice) => invoice.subtotal_ex_gst,
    (invoice) => invoice.total_inc_gst
  );
  const clientDrafts = tally(
    input.clientInvoices,
    (invoice) => invoice.status === "draft",
    (invoice) => invoice.subtotal_ex_gst,
    (invoice) => invoice.total_inc_gst
  );

  const originalContractIncGst = roundMoney(numberOrZero(input.originalContractIncGst));
  const approvedVariationsIncGst = roundMoney(
    numberOrZero(input.approvedVariationsExGst) * (1 + GST_RATE)
  );
  const adjustedContractIncGst = roundMoney(
    originalContractIncGst + approvedVariationsIncGst
  );
  const adjustedContractExGst = roundMoney(adjustedContractIncGst / (1 + GST_RATE));
  const plannedCostExGst = roundMoney(numberOrZero(input.plannedCostExGst));
  const forecastCostExGst = roundMoney(
    Math.max(plannedCostExGst, supplierApproved.total_ex_gst)
  );
  const forecastMarginExGst = roundMoney(adjustedContractExGst - forecastCostExGst);
  const currentRecordedPositionExGst = roundMoney(
    clientIssued.total_ex_gst - supplierApproved.total_ex_gst
  );

  const contractConfigured = originalContractIncGst > 0;
  const costPlanRequired = input.costPlanRequired !== false;
  const costPlanConfigured = !costPlanRequired || plannedCostExGst > 0;
  const forecastMarginPct =
    adjustedContractExGst > 0
      ? roundPercent((forecastMarginExGst / adjustedContractExGst) * 100)
      : null;
  const billingProgressPct =
    adjustedContractExGst > 0
      ? roundPercent((clientIssued.total_ex_gst / adjustedContractExGst) * 100)
      : null;
  const costProgressPct =
    forecastCostExGst > 0
      ? roundPercent((supplierApproved.total_ex_gst / forecastCostExGst) * 100)
      : null;
  const progressGapPoints =
    billingProgressPct !== null && costProgressPct !== null
      ? roundPercent(billingProgressPct - costProgressPct)
      : null;

  let status: FinancialPositionStatus;
  let story: string;

  if (!contractConfigured && !costPlanConfigured) {
    status = "needs_setup";
    story = "Add the client contract and cost plan to calculate the job position.";
  } else if (!contractConfigured) {
    status = "needs_setup";
    story = "Add the client contract value to calculate forecast margin.";
  } else if (!costPlanConfigured) {
    status = "needs_setup";
    story = "Complete the estimate cost plan to calculate a reliable forecast.";
  } else if (forecastMarginExGst < 0) {
    status = "at_risk";
    story = "Forecast costs exceed the adjusted client contract.";
  } else if (progressGapPoints !== null && progressGapPoints < -10) {
    status = "costs_ahead";
    story = `Approved costs are ${Math.abs(progressGapPoints).toFixed(
      1
    )} percentage points ahead of client billing.`;
  } else if (progressGapPoints !== null && progressGapPoints > 10) {
    status = "billing_ahead";
    story = `Client billing is ${progressGapPoints.toFixed(
      1
    )} percentage points ahead of approved costs.`;
  } else {
    status = "on_track";
    story = "Client billing and approved costs are currently tracking together.";
  }

  return {
    supplier_approved: supplierApproved,
    client_issued: clientIssued,
    client_paid: clientPaid,
    client_outstanding: clientOutstanding,
    client_drafts: clientDrafts,
    original_contract_inc_gst: originalContractIncGst,
    approved_variations_inc_gst: approvedVariationsIncGst,
    adjusted_contract_ex_gst: adjustedContractExGst,
    adjusted_contract_inc_gst: adjustedContractIncGst,
    planned_cost_ex_gst: plannedCostExGst,
    forecast_cost_ex_gst: forecastCostExGst,
    forecast_margin_ex_gst: forecastMarginExGst,
    forecast_margin_pct: forecastMarginPct,
    current_recorded_position_ex_gst: currentRecordedPositionExGst,
    billing_progress_pct: billingProgressPct,
    cost_progress_pct: costProgressPct,
    progress_gap_points: progressGapPoints,
    contract_configured: contractConfigured,
    cost_plan_configured: costPlanConfigured,
    cost_plan_required: costPlanRequired,
    status,
    story,
  };
}
