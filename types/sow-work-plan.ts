export type SowWorkPlanSuggestionState = "create" | "link" | "refresh" | "current";

export interface SowWorkPlanSuggestion {
  key: string;
  fingerprint: string;
  title: string;
  trade_role: string;
  phase_group_id: string | null;
  phase_name: string | null;
  line_ids: string[];
  line_previews: string[];
  section_headings: string[];
  existing_task_id: string | null;
  existing_task_title: string | null;
  assigned_contact_name: string | null;
  state: SowWorkPlanSuggestionState;
}

export interface SowWorkPlanPreviewResponse {
  sow_id: string;
  revision_label: string;
  suggestions: SowWorkPlanSuggestion[];
  summary: {
    scope_inclusions: number;
    included_lines: number;
    untagged_inclusions: number;
    unplanned_packages: number;
    current_packages: number;
    proposed_changes: number;
  };
}

export interface ApplySowWorkPlanInput {
  selections: { key: string; fingerprint: string }[];
}

export interface ApplySowWorkPlanResponse {
  created_count: number;
  linked_count: number;
  refreshed_count: number;
  skipped_count: number;
}
