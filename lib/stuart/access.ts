import type { User } from "@supabase/supabase-js";

export const DEFAULT_STUART_EMAIL = "accounts@reslu.com.au";

export function stuartEmail(): string {
  return process.env.STUART_EMAIL?.trim().toLowerCase() || DEFAULT_STUART_EMAIL;
}

export function isStuartUser(user: Pick<User, "email"> | null): boolean {
  return user?.email?.trim().toLowerCase() === stuartEmail();
}

export function isCronRequest(authorization: string | null): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  return Boolean(secret && authorization === `Bearer ${secret}`);
}
