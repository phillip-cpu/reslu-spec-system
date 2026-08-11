import type { ProfileRole } from "@/types";

const DEFAULT_XERO_ALLOWED_EMAILS = ["phillip@reslu.com.au"];

export interface XeroAccessUser {
  email: string | null;
  role: ProfileRole;
}

export function xeroAllowedEmails(): string[] {
  const configured = process.env.XERO_ALLOWED_EMAILS
    ?.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);
  return configured?.length ? configured : DEFAULT_XERO_ALLOWED_EMAILS;
}

/**
 * Xero contains company-confidential financial reporting, so an admin role is
 * necessary but not sufficient. Access is limited to a deliberate email
 * allowlist; this keeps service/agent admins (including Aria) outside Xero.
 */
export function hasXeroAccess<T extends XeroAccessUser>(user: T | null): user is T {
  return Boolean(
    user?.role === "admin" &&
      user.email &&
      xeroAllowedEmails().includes(user.email.toLowerCase())
  );
}
