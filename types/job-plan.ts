export type JobPlanView = "scope" | "trade" | "cost" | "procurement" | "programme";

export type JobPlanCostScope = "direct" | "trade_package";

export interface JobPlanScopeLineInput {
  id: string;
  section_id: string;
  room: string;
  text: string;
  kind: "inclusion" | "exclusion" | "note";
  trade: string | null;
}

export interface JobPlanItemInput {
  id: string;
  item_code: string;
  name: string;
  category: string;
  location: string | null;
  quantity: number;
  unit: string;
  cost_scope: JobPlanCostScope;
  status: string;
  price_trade: number | null;
  lead_time_weeks: number | null;
  ordered_at: string | null;
  eta: string | null;
}

export interface JobPlanActivityInput {
  id: string;
  title: string;
  trade_role: string | null;
  phase_name: string | null;
  phase_sort: number | null;
  status: string | null;
  booking_date: string | null;
  booking_end_date: string | null;
  due_date: string | null;
  contact_id: string | null;
  contractor_company: string | null;
  sow_revision_id: string | null;
}

export interface JobPlanActivityScopeLink {
  task_id: string;
  sow_line_id: string;
}

export interface JobPlanPhaseInput {
  id: string;
  name: string;
  sort: number;
}

export interface JobPlanItemRequirementInput {
  item_id: string;
  board_task_id: string;
  buffer_days: number;
  required_on_site_date: string | null;
}

export interface JobPlanCostLineInput {
  id: string;
  section_id: string;
  section_name: string;
  description: string;
  item_id: string | null;
  contact_id: string | null;
  qty: number | null;
  unit: string | null;
  rate_ex_gst: number | null;
  cost_ex_gst: number | null;
  quoted_to_client_ex_gst: number | null;
  actual_paid_ex_gst: number | null;
  quote_status: string | null;
}

export interface JobPlanQuotePackageInput {
  id: string;
  title: string;
  status: "draft" | "awaiting" | "received" | "selected" | "closed";
  line_ids: string[];
  item_ids: string[];
  supplier_names: string[];
  selected_supplier_name: string | null;
  next_due: string | null;
}

export interface JobPlanTradeAssignmentInput {
  trade_role: string;
  contact_id: string | null;
  contractor_company: string | null;
}

export interface JobPlanIssue {
  key: string;
  severity: "attention" | "info";
  label: string;
  destination: "scope" | "estimate" | "ffe" | "board" | "timeline";
}

export interface JobPlanThread {
  id: string;
  title: string;
  rooms: string[];
  scope_lines: JobPlanScopeLineInput[];
  trade: string | null;
  phase_name: string | null;
  phase_sort: number | null;
  contractor_company: string | null;
  contractor_source: "activity" | "trade_assignment" | null;
  items: JobPlanItemInput[];
  activities: JobPlanActivityInput[];
  requirements: JobPlanItemRequirementInput[];
  cost_lines: JobPlanCostLineInput[];
  quotes: JobPlanQuotePackageInput[];
  issues: JobPlanIssue[];
}

export interface JobPlanCoverage {
  scope_inclusions: number;
  scope_trade_tagged: number;
  scope_linked_to_activity: number;
  referenced_items: number;
  direct_items_missing_price: number;
  items_linked_to_activity: number;
  linked_cost_lines: number;
  quote_packages: number;
}

export interface JobPlanGroup {
  key: string;
  label: string;
  threads: JobPlanThread[];
}

export interface JobPlanModel {
  sow_id: string | null;
  sow_revision_label: string | null;
  sow_status: "draft" | "issued" | null;
  threads: JobPlanThread[];
  unlinked_items: JobPlanItemInput[];
  unlinked_activities: JobPlanActivityInput[];
  unlinked_cost_lines: JobPlanCostLineInput[];
  coverage: JobPlanCoverage;
}

export interface BuildJobPlanInput {
  sow_id: string | null;
  sow_revision_label: string | null;
  sow_status: "draft" | "issued" | null;
  scope_lines: JobPlanScopeLineInput[];
  items: JobPlanItemInput[];
  activities: JobPlanActivityInput[];
  phases: JobPlanPhaseInput[];
  activity_scope_links: JobPlanActivityScopeLink[];
  item_requirements: JobPlanItemRequirementInput[];
  cost_lines: JobPlanCostLineInput[];
  quote_packages: JobPlanQuotePackageInput[];
  trade_assignments: JobPlanTradeAssignmentInput[];
  include_financials: boolean;
}

export interface JobPlanPageData {
  project: {
    id: string;
    name: string;
    client_name: string;
    client_token: string;
  };
  is_admin: boolean;
  model: JobPlanModel;
}
