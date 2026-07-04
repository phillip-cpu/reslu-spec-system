import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { recordPortalAction } from "@/lib/gmail/digest";
import type { RespondVariationInput } from "@/app/portal/types";

/**
 * POST /api/portal/[token]/variation/[id]/respond
 *
 * Client approves/declines a shared variation from the portal (BUILD-SPEC.md
 * "Week 8 — Client portal expansion": "Approve/Decline buttons with note
 * dialog"). Same shape as the existing item approve/flag route
 * (app/api/portal/[token]/[action]/[itemId]/route.ts): unauthenticated,
 * token-gated, service-role client, and — per BUILD-SPEC.md §Security
 * ("Portal approve/flag routes MUST verify the item belongs to the
 * project matching the token") — the equivalent ownership check here:
 * the variation must belong to the project the token resolves to, AND
 * must be flagged share_to_portal, or the response is rejected.
 *
 * No item/variation pricing beyond the variation's own client-facing
 * cost_ex_gst (converted to inc-GST here, server-side) ever appears in
 * the response body.
 */

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

const GST_RATE = 0.1;

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string; id: string }> }
) {
  const { token, id: variationId } = await params;

  const limit = rateLimit(`portal-variation-respond:${token}:${clientIp(request)}`);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: RespondVariationInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.response !== "approved" && body.response !== "declined") {
    return NextResponse.json({ error: "response must be 'approved' or 'declined'" }, { status: 400 });
  }
  const note = typeof body.note === "string" ? body.note.trim() || null : null;

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id,name")
    .eq("client_token", token)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // Ownership + visibility check — MUST belong to this project and be
  // portal-shared, mirroring the item approve/flag route's boundary.
  const { data: variation } = await supabase
    .from("variations")
    .select("id,project_id,var_number,description,cost_ex_gst,share_to_portal")
    .eq("id", variationId)
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .single();

  if (!variation || !variation.share_to_portal) {
    return NextResponse.json({ error: "Variation not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const { data: updated, error: updateError } = await supabase
    .from("variations")
    .update({
      client_response: body.response,
      client_response_note: note,
      client_responded_at: now,
    })
    .eq("id", variation.id)
    .eq("project_id", project.id) // defence in depth
    .select("id,var_number,var_date,description,cost_ex_gst,client_response,client_response_note,client_responded_at")
    .single();

  if (updateError || !updated) {
    return NextResponse.json({ error: "Could not record your response" }, { status: 500 });
  }

  // Audit trail — approval_events is items-scoped only (item_id not
  // null in 001_initial.sql), so it can't carry a variation response.
  // A lightweight equivalent is recorded via the same digest queue used
  // for item approve/flag, tagged distinctly so the digest copy reads
  // sensibly; recordPortalAction never throws and never blocks this
  // route's response (see lib/gmail/digest.ts).
  void recordPortalAction(supabase, {
    projectId: project.id,
    itemId: variation.id,
    action: body.response === "approved" ? "approve" : "flag",
    note: note ? `Variation #${variation.var_number}: ${note}` : `Variation #${variation.var_number} ${body.response}`,
  });

  return NextResponse.json({
    variation: {
      id: updated.id,
      var_number: updated.var_number,
      var_date: updated.var_date,
      description: updated.description,
      cost_inc_gst: Math.round(updated.cost_ex_gst * (1 + GST_RATE) * 100) / 100,
      client_response: updated.client_response,
      client_response_note: updated.client_response_note,
      client_responded_at: updated.client_responded_at,
    },
  });
}
