export type ProjectCloseoutAreaKey =
  | "work"
  | "procurement"
  | "supplier_finance"
  | "client_account"
  | "handover_pack";

export type ProjectCloseoutAreaState = "clear" | "attention";

export interface ProjectCloseoutCounts {
  open_work_tasks: number;
  open_handover_tasks: number;
  handover_task_total: number;
  ffe_not_installed: number;
  ffe_total: number;
  supplier_needs_matching: number;
  supplier_approved_unpaid: number;
  client_invoice_drafts: number;
  client_invoices_unpaid: number;
  proposed_variations: number;
  pending_signatures: number;
  handover_candidates: number;
  handover_selected: number;
  compliance_certificates_selected: number;
  manuals_warranties_selected: number;
  gallery_candidates: number;
  gallery_selected: number;
}

export interface ProjectCloseoutArea {
  key: ProjectCloseoutAreaKey;
  label: string;
  state: ProjectCloseoutAreaState;
  summary: string;
  detail: string;
  href: string;
  action: string;
  outstanding_items: number;
}

export interface ProjectCloseoutReadiness {
  project_id: string;
  generated_at: string;
  ready: boolean;
  clear_area_count: number;
  attention_area_count: number;
  outstanding_item_count: number;
  counts: ProjectCloseoutCounts;
  areas: ProjectCloseoutArea[];
}
