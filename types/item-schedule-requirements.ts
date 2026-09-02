export interface ItemScheduleRequirementRow {
  id: string;
  project_id: string;
  item_id: string;
  board_task_id: string;
  buffer_days: number;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ItemScheduleActivity {
  id: string;
  project_id: string;
  title: string;
  trade_role: string | null;
  booking_date: string | null;
  phase_group_id: string | null;
  phase_name: string | null;
  phase_sort: number | null;
  phase_start_date: string | null;
  required_on_site_date: string | null;
  contractor_company: string | null;
}

export interface ItemScheduleRequirement extends ItemScheduleRequirementRow {
  activity: ItemScheduleActivity | null;
}

export interface ItemScheduleRequirementsResponse {
  requirements: ItemScheduleRequirement[];
  activities: ItemScheduleActivity[];
}

export interface OrderByRequirementInput {
  id: string;
  project_id: string;
  item_id: string;
  board_task_id: string;
  buffer_days: number;
  activity_title: string | null;
  trade_role: string | null;
  required_on_site_date: string | null;
}

