import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/projects/[id]/handover — internal curation list for the
 * Handover pack (BUILD-SPEC.md §"Phase 11 additions — confirmed by
 * Phillip" point 4: "Internal curation UI: tick which files/photos
 * belong in the pack"). Returns every CANDIDATE row across the three
 * source tables with its current in_handover_pack flag, so the team
 * can tick/untick without hunting across the Documents/Gallery/register
 * tabs separately:
 *
 *   - project_files: kind='certificate' (compliance certs) OR any
 *     OTHER kind already shared to the portal (the spec's "final
 *     documents") — a document not yet worth sharing at all is
 *     unlikely to be handover-worthy either, so this list is scoped to
 *     share_to_portal=true UNION kind='certificate' (certificates are
 *     offered even if not portal-shared yet, since they're commonly
 *     added right at project completion).
 *   - item_files: kind IN ('install_manual', 'warranty').
 *   - site_photos: not deleted (any photo, published or not, can be
 *     promoted into the final curated gallery).
 *
 * PATCH /api/projects/[id]/handover — Body: { table: 'project_files' |
 * 'item_files' | 'site_photos', id: string, in_handover_pack: boolean }.
 * Toggles the flag on the given row, verifying ownership against this
 * project first (item_files has no project_id column, so ownership is
 * checked via its parent item's project_id).
 *
 * Team-authenticated, not admin-only — nothing curated here is
 * financial.
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: projectFiles }, { data: itemFiles }, { data: sitePhotos }] = await Promise.all([
    supabase
      .from("project_files")
      .select("id,kind,filename,in_handover_pack,share_to_portal")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .or("kind.eq.certificate,share_to_portal.eq.true"),
    supabase
      .from("item_files")
      .select("id,item_id,kind,filename,in_handover_pack,items!inner(project_id,name)")
      .in("kind", ["install_manual", "warranty"])
      .eq("items.project_id", projectId),
    supabase
      .from("site_photos")
      .select("id,storage_path,caption,taken_at,in_handover_pack")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("taken_at", { ascending: false }),
  ]);

  return NextResponse.json({
    project_files: projectFiles ?? [],
    item_files: (itemFiles ?? []).map((f) => {
      // Supabase embeds items(name) as an object or array; the untyped
      // client infers it loosely, so cast the join shape.
      const joined = f.items as { name: string } | { name: string }[] | null;
      return {
        id: f.id,
        kind: f.kind,
        filename: f.filename,
        in_handover_pack: f.in_handover_pack,
        item_name: Array.isArray(joined) ? joined[0]?.name : joined?.name,
      };
    }),
    site_photos: sitePhotos ?? [],
  });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: { table?: string; id?: string; in_handover_pack?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { table, id, in_handover_pack } = body;
  if (!table || !id || typeof in_handover_pack !== "boolean") {
    return NextResponse.json({ error: "table, id, and in_handover_pack (boolean) are required" }, { status: 400 });
  }

  if (table === "project_files") {
    const { data: updated, error } = await supabase
      .from("project_files")
      .update({ in_handover_pack })
      .eq("id", id)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .select()
      .single();
    if (error || !updated) return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
    return NextResponse.json({ file: updated });
  }

  if (table === "site_photos") {
    const { data: updated, error } = await supabase
      .from("site_photos")
      .update({ in_handover_pack })
      .eq("id", id)
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .select()
      .single();
    if (error || !updated) return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
    return NextResponse.json({ photo: updated });
  }

  if (table === "item_files") {
    // item_files has no project_id column — verify ownership via the
    // parent item's project_id before touching it (same discipline as
    // every other cross-table write in this codebase).
    const { data: file } = await supabase
      .from("item_files")
      .select("id,item_id,items!inner(project_id)")
      .eq("id", id)
      .eq("items.project_id", projectId)
      .single();
    if (!file) {
      return NextResponse.json({ error: "Not found in this project" }, { status: 404 });
    }
    const { data: updated, error } = await supabase
      .from("item_files")
      .update({ in_handover_pack })
      .eq("id", id)
      .select()
      .single();
    if (error || !updated) return NextResponse.json({ error: error?.message ?? "Could not update" }, { status: 500 });
    return NextResponse.json({ file: updated });
  }

  return NextResponse.json({ error: "table must be one of project_files, item_files, site_photos" }, { status: 400 });
}
