import type { ContactPickerOption } from "@/types/board-cockpit";

export interface ProjectTradeContact extends ContactPickerOption {
  category: string | null;
}

export interface ProjectTradeAssignment {
  id: string;
  project_id: string;
  trade_role: string;
  role_key: string;
  contact_id: string | null;
  created_at: string;
  updated_at: string;
  contact: ProjectTradeContact | null;
}

export interface ProjectTradeAssignmentsResponse {
  assignments: ProjectTradeAssignment[];
}
