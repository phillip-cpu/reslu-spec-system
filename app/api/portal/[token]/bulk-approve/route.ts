import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import type { PortalItem } from "@/types";

/** PortalItem plus the Phase 11B decision-deadline field (types/index.ts
 * is owned by another agent working this tree concurrently — see
 * app/portal/types.ts's existing "portal-local type additions"
 * pattern, followed here rather than editing that shared file). */
type PortalItemWithDeadline = PortalItem & { decision_needed_by: string | null };

/**
 * POST /api/portal/[token]/bulk-approve
 *
 * Body: { location: string } — approves every NOT-flagged, NOT-yet-
 * approved item in the given room/location for the project matching
 * this token, in one action ("Approve all N in this room" per
 * BUILD-SPEC.md §"Selections (FF&E approvals)"):
 *
 *   "'Approve all N in this room' bulk action (confirm dialog; writes
 *   individual approval_events per item so the audit trail stays
 *   per-item) ... Approving via bulk never includes flagged items."
 *
 * Security/ownership: same discipline as the existing single-item
 * .../[action]/[itemId] route — token -> project lookup, then every
 * update/insert is scoped `.eq("project_id", project.id)`, so a bulk
 * call can never touch another project's items even if a location
 * name collides across projects. Rate-limited per token+ip like every
 * other portal route.
 *
 * Response: { approved_count, items } — the updated PortalItem rows
 * (bare shape, same as the single-item route) so the client can merge
 * them into its local state without a full page reload.
 */

const PORTAL_FIELDS =
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note,decision_needed_by";

function clientIp(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd?.split(",")[0]?.trim() || "unknown";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;

  const limit = rateLimit(`portal-bulk:${token}:${clientIp(request)}`);
  if (!limit.ok) {
    return NextResponse.json(
      { error: "Too many requests. Please slow down." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } }
    );
  }

  let body: { location?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const location = body.location?.trim();
  if (!location) {
    return NextResponse.json({ error: "location is required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("client_token", token)
    .single();

  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // Select the candidate set first (not-flagged, not-yet-approved, this
  // room) so we know exactly which item ids are being actioned for the
  // per-item approval_events audit trail below — a single UPDATE ...
  // RETURNING would give us the same rows, but selecting first makes
  // the "never includes flagged items" exclusion explicit and easy to
  // verify by reading, matching this route's own doc comment.
  const { data: candidates } = await supabase
    .from("items")
    .select("id,name,supplier,brand,selected_image_url")
    .eq("project_id", project.id)
    .eq("location", location)
    .eq("client_flagged", false)
    .eq("client_approved", false)
    .is("deleted_at", null);

  const rows = candidates ?? [];
  if (rows.length === 0) {
    return NextResponse.json({ approved_count: 0, items: [] });
  }

  const ids = rows.map((r) => r.id);
  const now = new Date().toISOString();

  const { data: updated, error: updateError } = await supabase
    .from("items")
    .update({ client_approved: true, client_actioned_at: now })
    .in("id", ids)
    .eq("project_id", project.id) // defence in depth
    .eq("client_flagged", false) // defence in depth — never flip a flagged item mid-race
    .select(PORTAL_FIELDS);

  if (updateError) {
    return NextResponse.json({ error: "Could not record your approval" }, { status: 500 });
  }

  // Per-item approval_events rows — BUILD-SPEC.md: "writes individual
  // approval_events per item so the audit trail stays per-item", i.e.
  // NOT one combined "bulk approve" event, exactly like the single-item
  // route's existing insert shape.
  const events = rows.map((r) => ({
    item_id: r.id,
    action: "approve" as const,
    note: `Approved via 'Approve all in room' (${location}).`,
    portal_token: token,
    item_snapshot: {
      name: r.name,
      supplier: r.supplier,
      brand: r.brand,
      selected_image_url: r.selected_image_url,
    },
  }));
  await supabase.from("approval_events").insert(events);

  return NextResponse.json({
    approved_count: updated?.length ?? 0,
    items: (updated ?? []) as PortalItemWithDeadline[],
  });
}
