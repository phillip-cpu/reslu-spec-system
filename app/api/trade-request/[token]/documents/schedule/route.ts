import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { findRepresentativeVisitToken } from "@/lib/trade-request";

export const runtime = "nodejs";

/**
 * GET /api/trade-request/[token]/documents/schedule
 * Grouped trade booking round (r20) — see the sibling `plans` route's
 * doc comment for the full "thin redirect to the existing r15 per-
 * visit proxy" rationale; identical shape, just the schedule endpoint.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-request-doc-schedule:${token}:${clientIp}`);
  if (!limit.ok) {
    return NextResponse.json({ error: "Too many requests, please try again shortly." }, { status: 429 });
  }

  const supabase = createServiceRoleClient();
  const { data: bookingRequest } = await supabase
    .from("trade_booking_requests")
    .select("id")
    .eq("token", token)
    .maybeSingle();
  if (!bookingRequest) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const visitToken = await findRepresentativeVisitToken(supabase, bookingRequest.id);
  if (!visitToken) {
    return NextResponse.json({ error: "No documents are available for this request." }, { status: 404 });
  }

  return NextResponse.redirect(new URL(`/api/trade/${visitToken}/documents/schedule`, request.url));
}
