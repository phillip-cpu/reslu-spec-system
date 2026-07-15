// ============================================================
// RESLU Spec System — Phase 3: Data Quality & Programme Guardrails.
// Local response/input types for the read-only diagnostics engine.
// Kept out of protected types/index.ts, following the established
// round-owned type-file convention used throughout this repository.
// ============================================================

export type DataQualitySeverity = "critical" | "warning" | "info";
export type DataQualityArea = "register" | "pricing" | "procurement" | "programme";
export type DataQualityEntityKind = "item" | "task" | "visit" | "project";

export interface DataQualityEntityRef {
  id: string;
  label: string;
  kind: DataQualityEntityKind;
}

export interface ProjectDataQualityIssue {
  code: string;
  severity: DataQualitySeverity;
  area: DataQualityArea;
  title: string;
  detail: string;
  count: number;
  samples: DataQualityEntityRef[];
  href: string;
}

export interface ProjectPricingCoverage {
  total_items: number;
  priced_items: number;
  priced_item_pct: number;
  quoted_items: number;
  placeholder_items: number;
  unpriced_items: number;
  known_value_ex_gst: number;
  quoted_value_ex_gst: number;
  quoted_value_pct: number;
}

export interface ProjectDataQualityResponse {
  project_id: string;
  generated_at: string;
  summary: {
    critical: number;
    warning: number;
    info: number;
    affected_records: number;
  };
  pricing: ProjectPricingCoverage;
  issues: ProjectDataQualityIssue[];
}

/**
 * Small enough for Aria's company-wide MCP scan while retaining every
 * actionable rule. Detail and samples remain available by requesting one
 * project with response_format=detailed.
 */
export interface ProjectDataQualityCompactResponse {
  project_id: string;
  summary: ProjectDataQualityResponse["summary"];
  pricing: Pick<
    ProjectPricingCoverage,
    "total_items" | "priced_item_pct" | "unpriced_items"
  >;
  issues: Array<
    Pick<ProjectDataQualityIssue, "code" | "severity" | "count">
  >;
}

export interface DataQualityItemInput {
  id: string;
  item_code: string;
  category: string;
  name: string;
  quantity: number;
  status: string;
  supplier: string | null;
  supplier_contact_id: string | null;
  price_trade: number | null;
  price_rrp: number | null;
  lead_time_weeks: number | null;
  ordered_at: string | null;
  delivered_at: string | null;
}

export interface DataQualityTaskInput {
  id: string;
  title: string;
  column_id: string;
  booking_date: string | null;
  booking_end_date: string | null;
  visit_id: string | null;
}

export interface DataQualityColumnInput {
  id: string;
  name: string;
}

export interface DataQualityVisitInput {
  id: string;
  status: string;
  start_date: string;
  end_date: string;
}

export interface DataQualityOrderByInput {
  item_id: string;
  status: "no_lead_time" | "no_booking" | "overdue" | "due_soon" | "ok";
  order_by: string | null;
  works_date: string | null;
}

export interface ProjectDataQualityInput {
  project_id: string;
  items: DataQualityItemInput[];
  room_item_ids: string[];
  columns: DataQualityColumnInput[];
  tasks: DataQualityTaskInput[];
  visits: DataQualityVisitInput[];
  order_by: DataQualityOrderByInput[];
  today: string;
}
