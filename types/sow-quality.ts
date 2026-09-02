import type { PlanDiscrepancy } from "@/types/phase-12a-a";

export type SowQualitySeverity = "blocker" | "warning";

export interface SowQualityFinding {
  code:
    | "placeholder_lines"
    | "empty_room"
    | "untagged_inclusions"
    | "duplicate_section"
    | "duplicate_lines"
    | "unresolved_scope_check"
    | "unresolved_tbc"
    | "missing_room_reference"
    | "uncovered_ffe_items"
    | "plan_discrepancy"
    | "plan_not_analysed";
  severity: SowQualitySeverity;
  title: string;
  detail: string;
  section_id?: string;
  line_ids?: string[];
  item_codes?: string[];
  plan_filename?: string;
  discrepancy?: PlanDiscrepancy;
}

export interface SowQualityReport {
  ready_to_issue: boolean;
  checked_at: string;
  blockers: SowQualityFinding[];
  warnings: SowQualityFinding[];
  summary: {
    sections: number;
    lines: number;
    active_rooms: number;
    assigned_ffe_items: number;
    referenced_ffe_items: number;
    analysed_plan_files: number;
  };
}

export interface SowQualityRoom {
  id: string;
  name: string;
}

export interface SowQualityItemAllocation {
  room_id: string;
  item_id: string;
  item_code: string;
  name: string;
}

export interface SowQualityPlanAnalysis {
  file_id: string;
  filename: string;
  discrepancies: PlanDiscrepancy[];
}

export interface SowQualityInput {
  sections: Array<{
    id: string;
    heading: string;
    source_room_id: string | null;
    lines: Array<{
      id: string;
      text: string;
      kind: "inclusion" | "exclusion" | "note";
      trade: string | null;
    }>;
  }>;
  rooms: SowQualityRoom[];
  allocations: SowQualityItemAllocation[];
  plan_files: Array<{ id: string; filename: string }>;
  plan_analyses: SowQualityPlanAnalysis[];
}
