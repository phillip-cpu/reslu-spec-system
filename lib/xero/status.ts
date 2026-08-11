import { createServiceRoleClient } from "@/lib/supabase/server";
import { XERO_REPORT_SCOPES, xeroConfigured } from "@/lib/xero/oauth";
import type { XeroConnectionStatus } from "@/types/xero";

export async function getXeroConnectionStatus(): Promise<XeroConnectionStatus> {
  const configured = xeroConfigured();
  if (!configured) {
    return {
      configured: false,
      connected: false,
      reporting_access: false,
      tenant_name: null,
      tenant_id: null,
      connected_at: null,
      last_sync_completed_at: null,
      last_sync_error: null,
      invoice_count: 0,
      payment_count: 0,
    };
  }

  const service = createServiceRoleClient();
  const { data: connection, error } = await service
    .from("xero_connections")
    .select("id,tenant_id,tenant_name,connected_at,last_sync_completed_at,last_sync_error,scopes")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!connection) {
    return {
      configured: true,
      connected: false,
      reporting_access: false,
      tenant_name: null,
      tenant_id: null,
      connected_at: null,
      last_sync_completed_at: null,
      last_sync_error: null,
      invoice_count: 0,
      payment_count: 0,
    };
  }

  const [invoiceResult, paymentResult] = await Promise.all([
    service.from("xero_invoices").select("id", { count: "exact", head: true }).eq("connection_id", connection.id),
    service.from("xero_payments").select("id", { count: "exact", head: true }).eq("connection_id", connection.id),
  ]);

  return {
    configured: true,
    connected: true,
    reporting_access: XERO_REPORT_SCOPES.every((scope) =>
      (connection.scopes ?? []).includes(scope)
    ),
    tenant_name: connection.tenant_name,
    tenant_id: connection.tenant_id,
    connected_at: connection.connected_at,
    last_sync_completed_at: connection.last_sync_completed_at,
    last_sync_error: connection.last_sync_error,
    invoice_count: invoiceResult.count ?? 0,
    payment_count: paymentResult.count ?? 0,
  };
}
