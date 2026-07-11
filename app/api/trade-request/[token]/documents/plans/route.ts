import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { findRepresentativeVisitToken } from "@/lib/trade-request";

export const runtime = "nodejs";

/**
 * GET /api/trade-request/[token]/documents/plans
 *
 * Grouped trade booking round (r20) — thin redirect wrapper, NOT a
 * reimplementation. A grouped request's document_pack is frozen
 * identically onto every line at send time, so this just resolves the
 * request's token to ONE representative line's OWN confirm_token (see
 * lib/trade-request.ts's findRepresentativeVisitToken) and 307s to the
 * EXISTING, unmodified GET /api/trade/[token]/documents/plans, which
 * does all the real work (pack check, latest-revision lookup, signed
 * URL) — genuine reuse of the r15 doc-pack machinery per BUILD-SPEC.md
 * item 2, not a parallel code path.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const headerList = await headers();
  const forwardedFor = headerList.get("x-forwarded-for");
  const clientIp = forwardedFor?.split(",")[0]?.trim() || "unknown";
  const limit = rateLimit(`trade-request-doc-plans:${token}:${clientIp}`);
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

  return NextResponse.redirect(new URL(`/api/trade/${visitToken}/documents/plans`, request.url));
}
