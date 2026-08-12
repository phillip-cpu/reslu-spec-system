import { createServiceRoleClient } from "@/lib/supabase/server";
import { decryptXeroSecret, encryptXeroSecret } from "@/lib/xero/crypto";
import { xeroRedirectUri } from "@/lib/xero/oauth";

export interface StoredXeroConnection {
  id: string;
  tenant_id: string;
  tenant_name: string;
  access_token_encrypted: string;
  refresh_token_encrypted: string;
  access_token_expires_at: string;
  scopes: string[];
}

interface XeroTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope?: string;
}

const refreshInFlight = new Map<string, Promise<string>>();

export async function exchangeXeroCode(code: string): Promise<XeroTokenResponse> {
  return requestTokens({ grant_type: "authorization_code", code, redirect_uri: xeroRedirectUri() });
}

async function requestTokens(fields: Record<string, string>): Promise<XeroTokenResponse> {
  const clientId = process.env.XERO_CLIENT_ID;
  const clientSecret = process.env.XERO_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("Xero OAuth credentials are not configured");
  const response = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as Partial<XeroTokenResponse> & { error?: string };
  if (!response.ok || !body.access_token || !body.refresh_token || !body.expires_in) {
    throw new Error(`Xero token request failed (${response.status}): ${body.error ?? "invalid response"}`);
  }
  return body as XeroTokenResponse;
}

export async function listXeroTenants(accessToken: string): Promise<Array<{
  tenantId: string;
  tenantName: string;
  tenantType?: string;
  updatedDateUtc?: string;
}>> {
  const response = await fetch("https://api.xero.com/connections", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Xero connections request failed (${response.status})`);
  return (await response.json()) as Array<{
    tenantId: string;
    tenantName: string;
    tenantType?: string;
    updatedDateUtc?: string;
  }>;
}

export async function getActiveXeroConnection(): Promise<StoredXeroConnection | null> {
  const service = createServiceRoleClient();
  const { data, error } = await service
    .from("xero_connections")
    .select("id,tenant_id,tenant_name,access_token_encrypted,refresh_token_encrypted,access_token_expires_at,scopes")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as StoredXeroConnection | null) ?? null;
}

async function refreshAccessToken(connection: StoredXeroConnection): Promise<string> {
  const existing = refreshInFlight.get(connection.id);
  if (existing) return existing;
  const refresh = (async () => {
    // Xero rotates refresh tokens. A previous concurrent request may already
    // have stored a newer token, so always reload the current ciphertext
    // before exchanging it rather than trusting the caller's stale snapshot.
    const service = createServiceRoleClient();
    const { data: latest, error: latestError } = await service
      .from("xero_connections")
      .select("refresh_token_encrypted")
      .eq("id", connection.id)
      .single();
    if (latestError || !latest) {
      throw new Error(latestError?.message ?? "Could not load Xero refresh token");
    }
    const tokens = await requestTokens({
      grant_type: "refresh_token",
      refresh_token: decryptXeroSecret(latest.refresh_token_encrypted),
    });
    const expires = new Date(Date.now() + tokens.expires_in * 1000).toISOString();
    const { error } = await service
      .from("xero_connections")
      .update({
        access_token_encrypted: encryptXeroSecret(tokens.access_token),
        refresh_token_encrypted: encryptXeroSecret(tokens.refresh_token),
        access_token_expires_at: expires,
        last_refreshed_at: new Date().toISOString(),
      })
      .eq("id", connection.id);
    if (error) throw new Error(error.message);
    return tokens.access_token;
  })();
  refreshInFlight.set(connection.id, refresh);
  try {
    return await refresh;
  } finally {
    refreshInFlight.delete(connection.id);
  }
}

async function validAccessToken(connection: StoredXeroConnection): Promise<string> {
  const expiresAt = new Date(connection.access_token_expires_at).getTime();
  if (expiresAt - Date.now() > 5 * 60 * 1000) {
    return decryptXeroSecret(connection.access_token_encrypted);
  }
  return refreshAccessToken(connection);
}

export async function xeroGet<T>(
  connection: StoredXeroConnection,
  path: string,
  query?: Record<string, string>
): Promise<T> {
  const url = new URL(path, "https://api.xero.com/");
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const request = (token: string) => fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": connection.tenant_id,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  let token = await validAccessToken(connection);
  let response = await request(token);
  // Access tokens can be revoked before their nominal expiry. Refresh and
  // retry once; never loop and never expose Xero's response body.
  if (response.status === 401) {
    token = await refreshAccessToken(connection);
    response = await request(token);
  }
  if (!response.ok) {
    // Do not copy Xero response bodies into browser errors, sync audit rows,
    // or server logs: they can contain accounting/contact data.
    throw new Error(`Xero API request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

async function xeroWrite<T>(
  connection: StoredXeroConnection,
  path: string,
  init: { method: "POST" | "PUT"; body: BodyInit; contentType: string }
): Promise<T> {
  const url = new URL(path, "https://api.xero.com/");
  const request = (token: string) => fetch(url, {
    method: init.method,
    headers: {
      Authorization: `Bearer ${token}`,
      "xero-tenant-id": connection.tenant_id,
      Accept: "application/json",
      "Content-Type": init.contentType,
    },
    body: init.body,
    cache: "no-store",
  });
  let token = await validAccessToken(connection);
  let response = await request(token);
  if (response.status === 401) {
    token = await refreshAccessToken(connection);
    response = await request(token);
  }
  if (!response.ok) throw new Error(`Xero API write failed (${response.status})`);
  return (await response.json()) as T;
}

export async function xeroPostJson<T>(
  connection: StoredXeroConnection,
  path: string,
  body: unknown
): Promise<T> {
  return xeroWrite<T>(connection, path, {
    method: "POST",
    body: JSON.stringify(body),
    contentType: "application/json",
  });
}

export async function xeroPutBytes<T>(
  connection: StoredXeroConnection,
  path: string,
  bytes: Uint8Array,
  contentType: string
): Promise<T> {
  return xeroWrite<T>(connection, path, {
    method: "PUT",
    body: Buffer.from(bytes),
    contentType,
  });
}
