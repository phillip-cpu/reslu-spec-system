import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { encryptXeroSecret } from "@/lib/xero/crypto";
import { exchangeXeroCode, listXeroTenants } from "@/lib/xero/client";
import { XERO_STATE_COOKIE } from "@/lib/xero/oauth";

function settingsRedirect(request: NextRequest, status: string): URL {
  const url = new URL("/settings", request.url);
  url.searchParams.set("xero", status);
  url.hash = "connections-system";
  return url;
}

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  const state = request.nextUrl.searchParams.get("state");
  const code = request.nextUrl.searchParams.get("code");
  const expectedState = request.cookies.get(XERO_STATE_COOKIE)?.value;
  if (!state || !expectedState || state !== expectedState || !code) {
    return NextResponse.redirect(settingsRedirect(request, "invalid_state"));
  }

  try {
    const tokens = await exchangeXeroCode(code);
    const tenants = await listXeroTenants(tokens.access_token);
    const configuredTenant = process.env.XERO_TENANT_ID?.trim();
    const tenant = configuredTenant
      ? tenants.find((candidate) => candidate.tenantId === configuredTenant)
      : tenants.length === 1
        ? tenants[0]
        : null;
    if (!tenant) {
      return NextResponse.redirect(settingsRedirect(request, "tenant_selection_required"));
    }

    const service = createServiceRoleClient();
    await service.from("xero_connections").update({ is_active: false }).eq("is_active", true);
    const { error } = await service.from("xero_connections").upsert({
      tenant_id: tenant.tenantId,
      tenant_name: tenant.tenantName,
      tenant_type: tenant.tenantType ?? null,
      access_token_encrypted: encryptXeroSecret(tokens.access_token),
      refresh_token_encrypted: encryptXeroSecret(tokens.refresh_token),
      access_token_expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      scopes: tokens.scope?.split(" ").filter(Boolean) ?? [],
      is_active: true,
      connected_by: user.userId,
      connected_at: new Date().toISOString(),
      last_sync_error: null,
    }, { onConflict: "tenant_id" });
    if (error) throw new Error(error.message);

    const response = NextResponse.redirect(settingsRedirect(request, "connected"));
    response.cookies.delete(XERO_STATE_COOKIE);
    return response;
  } catch (error) {
    console.error("xero-oauth-callback", error);
    return NextResponse.redirect(settingsRedirect(request, "connection_failed"));
  }
}
