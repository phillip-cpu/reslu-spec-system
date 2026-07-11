import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { findRepresentativeVisitToken } from "@/lib/trade-request";

export const runtime = "nodejs";

/**
 * GET /api/trade-request/[token]/documents/sow
 * Grouped trade booking round (r20) — see the sibling `plans` route's
 * doc comment for the full "thin redirect to the existing r15 per-
 * visit proxy" rationale; identical shape, just the SOW endpoint.
 * `?trade=` (trade-scoped extract) is forwarded through unchanged if
 * present, same query the r15 trade page itself would build.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  const trade = request.nextUrl.searchParams.get("trade");

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-request-doc-sow:${token}:${clientIp}`);
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

  const target = new URL(`/api/trade/${visitToken}/documents/sow`, request.url);
  if (trade) target.searchParams.set("trade", trade);
  return NextResponse.redirect(target);
}
