import { randomBytes } from "node:crypto";

export const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  "accounting.invoices.read",
  "accounting.payments.read",
] as const;

export const XERO_STATE_COOKIE = "reslu_xero_oauth_state";

export function xeroConfigured(): boolean {
  return Boolean(
    process.env.XERO_CLIENT_ID &&
      process.env.XERO_CLIENT_SECRET &&
      process.env.XERO_TOKEN_ENCRYPTION_KEY &&
      process.env.NEXT_PUBLIC_APP_URL
  );
}

export function xeroRedirectUri(): string {
  const explicit = process.env.XERO_REDIRECT_URI?.trim();
  if (explicit) return explicit;
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "");
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  return `${appUrl}/api/xero/callback`;
}

export function createXeroState(): string {
  return randomBytes(32).toString("base64url");
}

export function xeroAuthorizationUrl(state: string): string {
  const clientId = process.env.XERO_CLIENT_ID;
  if (!clientId) throw new Error("XERO_CLIENT_ID is not configured");
  const url = new URL("https://login.xero.com/identity/connect/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", xeroRedirectUri());
  url.searchParams.set("scope", XERO_SCOPES.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}
