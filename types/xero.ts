export interface XeroConnectionStatus {
  configured: boolean;
  connected: boolean;
  tenant_name: string | null;
  tenant_id: string | null;
  connected_at: string | null;
  last_sync_completed_at: string | null;
  last_sync_error: string | null;
  invoice_count: number;
  payment_count: number;
}

export interface XeroSyncResult {
  invoices_checked: number;
  payments_checked: number;
  completed_at: string;
}

export type XeroReportKey =
  | "profit_and_loss"
  | "balance_sheet"
  | "trial_balance"
  | "bank_summary"
  | "budget_summary"
  | "executive_summary"
  | "bas";

export interface XeroReportCell {
  Value?: string;
}

export interface XeroReportRow {
  RowType?: string;
  Title?: string;
  Cells?: XeroReportCell[];
  Rows?: XeroReportRow[];
}

export interface XeroReportField {
  FieldID?: string;
  Description?: string;
  Value?: string;
}

export interface XeroReport {
  ReportID?: string;
  ReportName?: string;
  ReportType?: string;
  ReportDate?: string;
  ReportTitles?: string[];
  Rows?: XeroReportRow[];
  Fields?: XeroReportField[];
}

export interface XeroReportResult {
  key: XeroReportKey;
  label: string;
  retrieved_at: string;
  reports: XeroReport[];
}
