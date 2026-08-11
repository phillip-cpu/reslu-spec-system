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
