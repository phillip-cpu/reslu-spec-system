import type { CostLine, CreateCostLineInput, PatchCostLineInput } from "@/types";

export type CostLineGstTreatment =
  | "exclusive"
  | "inclusive"
  | "gst_free"
  | "not_applicable";

export interface CostLineSourcePayment {
  id: string;
  cost_line_id: string;
  source_amount_minor: number;
  paid_on: string | null;
  settled_aud_minor: number | null;
  evidence_reference: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Additive finance fields stay feature-local because types/index.ts is a
 * protected integration surface. Optional fields keep legacy snapshots valid. */
export type ForeignCashCostLine = CostLine & {
  gst_treatment?: CostLineGstTreatment;
  source_currency?: string | null;
  source_forecast_total_minor?: number | null;
  forecast_fx_rate?: number | null;
  source_payments?: CostLineSourcePayment[];
};

export type PatchForeignCashCostLineInput = PatchCostLineInput & {
  gst_treatment?: CostLineGstTreatment;
  source_currency?: string | null;
  source_forecast_total_minor?: number | null;
  forecast_fx_rate?: number | null;
};

export type CreateForeignCashCostLineInput = CreateCostLineInput & {
  gst_treatment?: CostLineGstTreatment;
  source_currency?: string | null;
  source_forecast_total_minor?: number | null;
  forecast_fx_rate?: number | null;
};

export interface CreateCostLineSourcePaymentInput {
  source_amount_minor: number;
  paid_on?: string | null;
  settled_aud_minor?: number | null;
  evidence_reference?: string | null;
}
