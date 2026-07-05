import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
// Week 4 (lib/monday.ts + lib/gmail.ts owner, boundary: lib/gmail/**):
// queue this action for the batched team digest instead of sending an
// email inline on every portal click — see lib/gmail/digest.ts for the
// full design. This is the one permitted portal-file touch outside the
// Estimating/portal boundary; recordPortalAction() never throws and
// never blocks this route's response.
import { recordPortalAction } from "@/lib/gmail/digest";
import type { PortalItem } from "@/types";

/** PortalItem plus the Phase 11B decision-deadline field — see the
 * identical note in app/api/portal/[token]/bulk-approve/route.ts. */
type PortalItemWithDeadline = PortalItem & { decision_needed_by: string | null };

/**
 * POST /api/portal/[token]/[action]/[itemId]   action ∈ approve | flag
 *
 * Unauthenticated client-portal action. Uses the service-role client
 * (bypasses RLS) BUT is responsible for its own authorization:
 *
 *   BUILD-SPEC.md §Security (non-negotiable):
 *   "Portal approve/flag routes MUST verify the item belongs to the
 *    project matching the token."
 *
 * The verification below (item.project_id === project.id, item not
 * soft-deleted) is that boundary. Without it, any valid token could
 * action any item in any project.
 */

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note,decision_needed_by";

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: { params: Promise<{ token: string; action: string; itemId: string }> }
) {
  const { token, action, itemId } = await params;

  if (action !== "approve" && action !== "flag") {
    return NextResponse.json({ error: "Unknown action" }, { status: 404 });
  }

  // Rate limit per token+ip (BUILD-SPEC.md §Security).
  const limit = rateLimit(`portal:${token}:${clientIp(request)}`);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let note: string | null = null;
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.note === "string") note = body.note.trim() || null;
  } catch {
    // no body is fine
  }

  const supabase = createServiceRoleClient();

  // token → project
  const { data: project } = await supabase
    .from("projects")
    .select("id,name")
    .eq("client_token", token)
    .single();

  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // item → MUST belong to this project and not be soft-deleted.
  const { data: item } = await supabase
    .from("items")
    .select(
      "id,project_id,deleted_at,item_code,name,supplier,brand,selected_image_url,client_approved,client_flagged"
    )
    .eq("id", itemId)
    .eq("project_id", project.id)
    .is("deleted_at", null)
    .single();

  if (!item) {
    // Item not found in THIS project — the ownership check failing.
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }

  const now = new Date().toISOString();
  const updates =
    action === "approve"
      ? {
          client_approved: true,
          client_flagged: false,
          client_flag_note: null,
          client_actioned_at: now,
        }
      : {
          client_flagged: true,
          client_approved: false,
          client_flag_note: note,
          client_actioned_at: now,
        };

  const { data: updated, error: updateError } = await supabase
    .from("items")
    .update(updates)
    .eq("id", item.id)
    .eq("project_id", project.id) // defence in depth
    .select(PORTAL_FIELDS)
    .single();

  if (updateError || !updated) {
    return NextResponse.json(
      { error: "Could not record your response" },
      { status: 500 }
    );
  }

  // Audit trail with a snapshot (BUILD-SPEC.md §7 / Review §1.6).
  // Snapshot shape fixed to {name, supplier, brand, selected_image_url}
  // per the Week 3B portal audit — enough to identify what the client
  // was looking at without carrying the whole row (and definitely
  // without any pricing/ordering fields).
  await supabase.from("approval_events").insert({
    item_id: item.id,
    action,
    note,
    portal_token: token,
    item_snapshot: {
      name: item.name,
      supplier: item.supplier,
      brand: item.brand,
      selected_image_url: item.selected_image_url,
    },
  });

  // Team digest (BUILD-SPEC.md §9 / Review §1.8). Queues this action for
  // the batched per-project digest (lib/gmail/digest.ts) instead of
  // emailing inline — never fails the client's action, never throws.
  void recordPortalAction(supabase, {
    projectId: project.id,
    itemId: item.id,
    action,
    note,
  });

  return NextResponse.json({ item: updated as PortalItemWithDeadline });
}
