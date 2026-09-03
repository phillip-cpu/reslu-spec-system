export const FINANCE_CAPABILITIES = [
  "finance.view_company",
  "finance.view_project",
  "finance.activate_project",
  "finance.edit_forecast",
  "finance.resolve_match",
  "finance.manage_policy",
  "finance.manage_xero",
  "finance.run_sync",
  "finance.view_audit",
  "finance.export",
  "finance.use_ai",
  "finance.manage_access",
] as const;

export type FinanceCapability = (typeof FINANCE_CAPABILITIES)[number];

export type ProjectFinanceState =
  | "design_only"
  | "candidate"
  | "ready"
  | "active"
  | "suspended"
  | "closed"
  | "cancelled";

export const PROJECT_STAGES = [
  "design",
  "quoting",
  "preconstruction",
  "construction",
  "handover",
  "complete",
  "on_hold",
] as const;

export type ProjectStage = (typeof PROJECT_STAGES)[number];

export interface ProjectCommercialProfile {
  project_stage: ProjectStage;
  contract_type: "design" | "construction" | "other";
  contract_label: string;
  contract_amount_inc_gst: number;
  contract_reference: string | null;
  contract_signed_at: string | null;
  due_days: number;
}

export type SaveProjectCommercialProfileRequest = ProjectCommercialProfile;

export interface FinancePolicyVersion {
  id: string;
  policy_key: string;
  version_number: number;
  status: "draft" | "published" | "superseded";
  effective_from: string;
  configuration: Record<string, unknown>;
  confirmations: Record<string, unknown>;
  note: string | null;
  created_by: string | null;
  approved_by: string | null;
  created_at: string;
  approved_at: string | null;
}

export interface ProjectFinanceProfile {
  project_id: string;
  finance_state: ProjectFinanceState;
  policy_version_id: string | null;
  active_baseline_id: string | null;
  current_projection_id: string | null;
  activated_at: string | null;
  activated_by: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SignedContractEvidence {
  reference: string;
  signed_at: string;
  document_id?: string | null;
  storage_path?: string | null;
  note?: string | null;
}

export type FinanceReadinessCode =
  | "signed_contract"
  | "saved_estimate"
  | "dated_program"
  | "published_policy"
  | "lifecycle_state";

export interface FinanceReadinessCheck {
  code: FinanceReadinessCode;
  ready: boolean;
  message: string;
}

export interface FinanceActivationReadiness {
  ready: boolean;
  checks: FinanceReadinessCheck[];
  project_id: string;
  finance_state: ProjectFinanceState;
  profile_version: number;
  estimate_version_id: string | null;
  estimate_label: string | null;
  policy_version_id: string | null;
  program_watermark: string | null;
  program_phase_count: number;
}

export interface FinanceReadinessRequest {
  effective_date?: string;
  estimate_version_id?: string;
  policy_version_id?: string;
  contract_evidence?: Partial<SignedContractEvidence>;
}

export interface PublishFinancePolicyRequest {
  effective_from: string;
  configuration: Record<string, unknown>;
  confirmations: Record<string, unknown>;
  reason: string;
}

export interface ActivateProjectFinanceRequest extends FinanceReadinessRequest {
  effective_date: string;
  estimate_version_id: string;
  policy_version_id: string;
  contract_evidence: SignedContractEvidence;
  reason: string;
  idempotency_key: string;
  expected_profile_version: number;
  program_watermark: string;
}

export type FinanceDirection = "inflow" | "outflow";
export type FinanceContributionState =
  | "planned"
  | "committed"
  | "actual_accrued"
  | "actual_paid";
export type FinanceConfidence =
  | "confirmed"
  | "high"
  | "medium"
  | "low"
  | "unknown";

export type FinanceRecurringCategory =
  | "wages"
  | "superannuation"
  | "rent"
  | "marketing"
  | "entertainment"
  | "software"
  | "insurance"
  | "utilities"
  | "professional_fees"
  | "vehicles"
  | "other";

export type FinanceRecurringFrequency =
  | "once"
  | "weekly"
  | "fortnightly"
  | "monthly"
  | "quarterly"
  | "annually";

export type FinanceRecurringStatus = "draft" | "active" | "paused" | "archived";
export type FinanceGstTreatment =
  | "inclusive"
  | "exclusive"
  | "gst_free"
  | "not_applicable";

export interface FinanceRecurringCommitment {
  id: string;
  name: string;
  category: FinanceRecurringCategory;
  supplier_or_payee: string | null;
  amount_minor: number;
  frequency: FinanceRecurringFrequency;
  first_due_date: string;
  end_date: string | null;
  gst_treatment: FinanceGstTreatment;
  annual_escalation_bps: number;
  confidence: FinanceConfidence;
  status: FinanceRecurringStatus;
  notes: string | null;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SaveFinanceRecurringCommitmentRequest {
  id?: string | null;
  name: string;
  category: FinanceRecurringCategory;
  supplier_or_payee?: string | null;
  amount_minor: number;
  frequency: FinanceRecurringFrequency;
  first_due_date: string;
  end_date?: string | null;
  gst_treatment: FinanceGstTreatment;
  annual_escalation_bps: number;
  confidence: FinanceConfidence;
  status: Exclude<FinanceRecurringStatus, "archived">;
  notes?: string | null;
  expected_version?: number | null;
  reason: string;
}

export interface FinanceRecurringCommitmentsResponse {
  commitments: FinanceRecurringCommitment[];
  can_edit: boolean;
  as_of_date: string;
  summary: {
    active_count: number;
    projected_outflow_minor: number;
    next_due_date: string | null;
  };
}

export type FinanceCreditFacilityType =
  | "overdraft"
  | "credit_card"
  | "line_of_credit"
  | "other";

export interface FinanceCreditFacility {
  id: string;
  name: string;
  provider: string | null;
  facility_type: FinanceCreditFacilityType;
  xero_bank_account_id: string;
  xero_account_name: string;
  xero_bank_account_type: "BANK" | "CREDITCARD" | "LIABILITY";
  xero_balance_minor: number | null;
  xero_balance_as_of: string | null;
  xero_balance_source: "bank_summary" | "balance_sheet" | null;
  credit_limit_minor: number;
  available_credit_minor: number;
  interest_rate_bps: number | null;
  status: "active" | "paused" | "closed";
  notes: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface SaveFinanceCreditFacilityRequest {
  id?: string | null;
  xero_bank_account_id: string;
  name?: string;
  provider?: string | null;
  facility_type: FinanceCreditFacilityType;
  credit_limit_minor: number;
  interest_rate_bps?: number | null;
  status: "active" | "paused" | "closed";
  notes?: string | null;
  expected_version?: number | null;
  reason: string;
}

export interface FinanceXeroFacilityAccount {
  id: string;
  xero_account_id: string;
  name: string;
  bank_account_type: "BANK" | "CREDITCARD" | "LIABILITY";
  balance_minor: number | null;
  balance_as_of: string | null;
  balance_source: "bank_summary" | "balance_sheet" | null;
}

export interface FinanceCreditFacilitiesResponse {
  facilities: FinanceCreditFacility[];
  xero_accounts: FinanceXeroFacilityAccount[];
  can_edit: boolean;
  summary: {
    credit_limit_minor: number;
    current_balance_minor: number;
    available_credit_minor: number;
    active_count: number;
    xero_balance_as_of: string | null;
  };
}

export interface FinanceContributionInput {
  contributionKey: string;
  direction: FinanceDirection;
  description: string;
  plannedMinor: number;
  committedMinor?: number;
  actualAccruedMinor?: number;
  actualPaidMinor?: number;
  plannedDate?: string | null;
  committedDate?: string | null;
  actualDueDate?: string | null;
  actualPaidDate?: string | null;
  baseEligible?: boolean;
  confidence?: FinanceConfidence;
  sourceTrace?: Record<string, unknown>;
}

export interface EffectiveFinanceContribution {
  contributionKey: string;
  direction: FinanceDirection;
  description: string;
  state: FinanceContributionState;
  amountMinor: number;
  effectiveDate: string | null;
  confidence: FinanceConfidence;
  sourceTrace: Record<string, unknown>;
}

export interface FinanceProjectionPeriod {
  periodKind: "week";
  periodIndex: number;
  startsOn: string;
  endsOn: string;
  openingCashMinor: number;
  inflowMinor: number;
  outflowMinor: number;
  actualInflowMinor: number;
  actualOutflowMinor: number;
  closingCashMinor: number;
  contributions: EffectiveFinanceContribution[];
}

export interface FinanceShadowProjection {
  calculationVersion: "finance-shadow-v1";
  asOfDate: string;
  openingCashMinor: number;
  periods: FinanceProjectionPeriod[];
  effectiveContributions: EffectiveFinanceContribution[];
  unknownTimingMinor: number;
  outsideHorizonMinor: number;
  excludedFromBaseMinor: number;
  lowestCashMinor: number;
  lowestCashPeriodIndex: number | null;
  totalInflowMinor: number;
  totalOutflowMinor: number;
}

export interface FinanceShadowProjectionRequest {
  as_of_date: string;
  opening_cash_minor?: number;
  estimate_version_id?: string;
  timing_overrides?: Record<string, string>;
}

export interface FinanceShadowProjectionResponse {
  mode: "shadow";
  persisted: false;
  committed_base_eligible: boolean;
  finance_state: ProjectFinanceState;
  source: {
    estimate_version_id: string | null;
    estimate_label: string | null;
    timing_override_count: number;
    schedule_link_count?: number;
    cost_section_count?: number;
    schedule_phase_count?: number;
    schedule_dated_phase_count?: number;
    latest_schedule_date?: string | null;
    ffe_direct_item_count?: number;
    ffe_timing_link_count?: number;
    ffe_quoted_item_count?: number;
    ffe_placeholder_item_count?: number;
    ffe_unpriced_item_count?: number;
    estimate_has_item_level_ffe?: boolean;
    estimate_ffe_direct_item_count?: number;
    client_claim_count: number;
    construction_costs_included?: boolean;
    opening_cash_source: "not_configured" | "request_preview" | "xero_bank_summary";
  };
  projection: FinanceShadowProjection;
}

export interface FinanceCockpitProject {
  project_id: string;
  name: string;
  job_number: string | null;
  finance_state: ProjectFinanceState;
  baseline_id: string | null;
  baseline_effective_date: string | null;
  exposure_minor: number;
  forecast_line_count: number;
  unknown_timing_minor: number;
  client_claim_count: number;
  client_inflow_minor: number;
  client_paid_minor: number;
}

export interface FinanceCockpitResponse {
  mode: "shadow";
  persisted: false;
  shadow_enabled: boolean;
  can_manage_policy: boolean;
  can_edit_forecast: boolean;
  source_status: {
    xero: "not_configured" | "connecting" | "healthy" | "degraded";
    opening_cash: "request_preview" | "not_configured" | "xero_bank_summary";
    xero_tenant_name: string | null;
    xero_last_sync_at: string | null;
    xero_cash_as_of: string | null;
    xero_invoice_actuals: number;
    xero_matched_invoices: number;
    xero_matched_supplier_bills: number;
    xero_unmatched_invoices: number;
    calculated_at: string;
  };
  counts: {
    active_projects: number;
    candidate_projects: number;
    design_only_projects: number;
    active_recurring_commitments: number;
    connected_client_claims: number;
    connected_projects: number;
    reconciled_supplier_invoices: number;
  };
  client_claims_summary: {
    contracted_minor: number;
    issued_minor: number;
    paid_minor: number;
    outstanding_minor: number;
    forecast_remaining_minor: number;
  };
  recurring_summary: {
    projected_outflow_minor: number;
    next_due_date: string | null;
  };
  liquidity_summary: {
    bank_cash_minor: number;
    credit_limit_minor: number;
    credit_drawn_minor: number;
    available_credit_minor: number;
    available_liquidity_minor: number;
    committed_low_minor: number;
    committed_liquidity_low_minor: number;
  };
  allowance_summary: {
    total_minor: number;
    dated_minor: number;
    undated_minor: number;
    overdue_minor: number;
    item_count: number;
  };
  projects: FinanceCockpitProject[];
  cash_projection: FinanceShadowProjection | null;
  planning_projection: FinanceShadowProjection | null;
  /** @deprecated Use cash_projection for the operating view. */
  projection: FinanceShadowProjection | null;
}

export interface ProjectFinanceResponse {
  project: {
    id: string;
    name: string;
    job_number: string | null;
    project_stage: ProjectStage;
  };
  commercial: ProjectCommercialProfile;
  finance: ProjectFinanceProfile & {
    active_baseline?: {
      id: string;
      effective_date: string;
      estimate_version_id: string;
      program_watermark: string;
      content_hash: string;
      created_at: string;
    } | null;
  };
}
