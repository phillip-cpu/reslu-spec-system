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
 * Body: { room_id: string | null } — approves every NOT-flagged, NOT-
 * yet-approved item allocated to the given room (item_rooms), or every
 * such UNASSIGNED item (room_id: null — no item_rooms row at all) for
 * the project matching this token, in one action ("Approve all N in
 * this room" per BUILD-SPEC.md §"Selections (FF&E approvals)"):
 *
 *   "'Approve all N in this room' bulk action (confirm dialog; writes
 *   individual approval_events per item so the audit trail stays
 *   per-item) ... Approving via bulk never includes flagged items."
 *
 * Bug fix, 7 July 2026: this route used to take `{ location: string }`
 * and match `.eq("location", location)` — items.location stopped being
 * the source of truth once Rooms became the primary grouping concept
 * (see lib/portal-rooms.ts's doc comment), so most items have
 * location = null and the UI's "Unassigned"/"Other" bucket sent a
 * display-only label string that matched zero real rows — silently
 * approving nothing. Now keyed by the item's real item_rooms
 * allocation.
 *
 * Security/ownership: same discipline as the existing single-item
 * .../[action]/[itemId] route — token -> project lookup, then every
 * update/insert is scoped `.eq("project_id", project.id)`, and a
 * supplied room_id is validated to belong to this project before use,
 * so a bulk call can never touch another project's items. Rate-limited
 * per token+ip like every other portal route.
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

  let body: { room_id?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (body.room_id === undefined) {
    return NextResponse.json({ error: "room_id is required (null for the Unassigned bucket)" }, { status: 400 });
  }
  const roomId = body.room_id;

  const supabase = createServiceRoleClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("client_token", token)
    .single();

  if (!project) {
    return NextResponse.json({ error: "Invalid link" }, { status: 404 });
  }

  // A supplied room must actually belong to this project — defence
  // against a forged/cross-project room_id (same discipline as every
  // other portal write route's project-scoping). Its name feeds the
  // approval_events note below.
  let roomName = "Unassigned";
  if (roomId) {
    const { data: room } = await supabase
      .from("rooms")
      .select("id,name")
      .eq("id", roomId)
      .eq("project_id", project.id)
      .is("deleted_at", null)
      .maybeSingle();
    if (!room) {
      return NextResponse.json({ error: "Invalid room" }, { status: 400 });
    }
    roomName = room.name;
  }

  // Resolve which item ids are actually IN this room (or, for the
  // Unassigned bucket, which items have NO item_rooms row at all) —
  // this is the fix: the old version matched on items.location, a
  // field that's null for most items now that Rooms replaced it as
  // the primary grouping concept (see this route's doc comment).
  const { data: allProjectItems } = await supabase
    .from("items")
    .select("id")
    .eq("project_id", project.id)
    .is("deleted_at", null);
  const allItemIds = (allProjectItems ?? []).map((i) => i.id);

  let scopedItemIds: string[];
  if (roomId) {
    const { data: allocs } = await supabase.from("item_rooms").select("item_id").eq("room_id", roomId);
    scopedItemIds = (allocs ?? []).map((a) => a.item_id);
  } else {
    const { data: allocs } = allItemIds.length
      ? await supabase.from("item_rooms").select("item_id").in("item_id", allItemIds)
      : { data: [] as { item_id: string }[] };
    const assigned = new Set((allocs ?? []).map((a) => a.item_id));
    scopedItemIds = allItemIds.filter((id) => !assigned.has(id));
  }

  // Select the candidate set first (not-flagged, not-yet-approved,
  // scoped to this room) so we know exactly which item ids are being
  // actioned for the per-item approval_events audit trail below — a
  // single UPDATE ... RETURNING would give us the same rows, but
  // selecting first makes the "never includes flagged items" exclusion
  // explicit and easy to verify by reading, matching this route's own
  // doc comment.
  const { data: candidates } = scopedItemIds.length
    ? await supabase
        .from("items")
        .select("id,name,supplier,brand,selected_image_url")
        .eq("project_id", project.id)
        .in("id", scopedItemIds)
        .eq("client_flagged", false)
        .eq("client_approved", false)
        .is("deleted_at", null)
    : { data: [] as { id: string; name: string; supplier: string | null; brand: string | null; selected_image_url: string | null }[] };

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
    note: `Approved via 'Approve all in room' (${roomName}).`,
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
