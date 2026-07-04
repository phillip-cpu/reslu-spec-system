import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { sendTeamEmail } from "@/lib/gmail";
import type { PortalItem } from "@/types";

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
  "id,item_code,name,description,supplier,quantity,location,status,selected_image_url,client_approved,client_flagged,client_flag_note";

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
    .select("*")
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

  // Team digest email (BUILD-SPEC.md §9 / Review §1.8). Best-effort and
  // dormant until Gmail credentials are configured — never fails the
  // client's action.
  void notifyTeam(supabase, project.id, project.name, item.name, action, note);

  return NextResponse.json({ item: updated as PortalItem });
}

/**
 * Fire-and-forget team digest. Computes the project's current approved /
 * flagged tallies so the email reads like "Client approved 4, flagged 2".
 * Any failure (including missing Gmail creds) is swallowed.
 */
async function notifyTeam(
  supabase: ReturnType<typeof createServiceRoleClient>,
  projectId: string,
  projectName: string,
  itemName: string,
  action: "approve" | "flag",
  note: string | null
): Promise<void> {
  try {
    const [{ data: team }, approved, flagged] = await Promise.all([
      supabase.from("profiles").select("email"),
      supabase
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .eq("client_approved", true),
      supabase
        .from("items")
        .select("*", { count: "exact", head: true })
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .eq("client_flagged", true),
    ]);

    const recipients = (team ?? [])
      .map((p: { email: string }) => p.email)
      .filter(Boolean);

    const verb = action === "approve" ? "approved" : "flagged";
    await sendTeamEmail({
      to: recipients,
      subject: `${projectName}: client ${verb} “${itemName}”`,
      body:
        `The client just ${verb} “${itemName}” on ${projectName}.` +
        (note ? `\n\nNote: ${note}` : "") +
        `\n\nProject status: ${approved.count ?? 0} approved, ${flagged.count ?? 0} flagged.`,
    });
  } catch {
    // digest is non-critical
  }
}
