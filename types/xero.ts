export interface XeroConnectionStatus {
  configured: boolean;
  connected: boolean;
  reporting_access: boolean;
  tenant_name: string | null;
  tenant_id: string | null;
  connected_at: string | null;
  last_sync_completed_at: string | null;
  last_sync_error: string | null;
  invoice_count: number;
  payment_count: number;
  bank_account_count: number;
  cash_balance: number | null;
  cash_balance_as_of: string | null;
}

export interface XeroSyncResult {
  invoices_checked: number;
  payments_checked: number;
  bank_accounts_checked: number;
  cash_balance: number;
  cash_balance_as_of: string;
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
