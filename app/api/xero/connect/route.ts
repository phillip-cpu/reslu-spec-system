import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import {
  createXeroState,
  XERO_STATE_COOKIE,
  xeroAuthorizationUrl,
  xeroConfigured,
} from "@/lib/xero/oauth";

export async function GET() {
  const supabase = await createClient();
  if (!(await isAdmin(supabase))) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  if (!xeroConfigured()) {
    return NextResponse.json({ error: "Xero integration is not configured" }, { status: 503 });
  }
  const state = createXeroState();
  const response = NextResponse.redirect(xeroAuthorizationUrl(state));
  response.cookies.set(XERO_STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/api/xero/callback",
    maxAge: 10 * 60,
  });
  return response;
}
