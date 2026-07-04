import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/projects/[id]/client-updates/summary
 *
 * One-shot summary for the team client-area page
 * (app/(dashboard)/projects/[id]/client/page.tsx): files with their
 * share_to_portal flag, variations with share_to_portal + response,
 * signature requests, and the fortnightly-cadence figure ("Last update
 * published N days ago"). Saves the page from firing five separate
 * fetches on load. Team-authenticated.
 *
 * Financial note: variations here DO include cost_ex_gst — this route
 * is team-side (session-authenticated, not portal/token-gated), and
 * variations are not in the admin-only financial-gating list the same
 * way price_trade/markup_pct are (BUILD-SPEC.md's financial-visibility
 * section names price_trade/markup_pct/price_client specifically); the
 * ADMIN gate that applies here is narrower and enforced on the SHARE
 * action itself (see .../variations/[variationId]/share/route.ts), not
 * on reading the list. This mirrors how the existing Estimate module's
 * variations tab already works for team members today.
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

  const [{ data: files }, { data: variations }, { data: signatureRequests }, { data: updates }, { data: photos }] =
    await Promise.all([
      supabase
        .from("project_files")
        .select("id,kind,filename,revision_label,share_to_portal,uploaded_at")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("uploaded_at", { ascending: false }),
      supabase
        .from("variations")
        .select("id,var_number,description,cost_ex_gst,status,share_to_portal,client_response,client_response_note,client_responded_at")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("var_number", { ascending: false }),
      supabase
        .from("signature_requests")
        .select("id,subject_type,subject_id,status,voided_reason,created_at")
        .eq("project_id", projectId)
        .order("created_at", { ascending: false }),
      supabase
        .from("portal_updates")
        .select("id,title,published_at,created_at")
        .eq("project_id", projectId)
        .is("deleted_at", null)
        .order("created_at", { ascending: false }),
      supabase
        .from("progress_photos")
        .select("id", { count: "exact", head: true })
        .eq("project_id", projectId)
        .is("deleted_at", null),
    ]);

  const publishedUpdates = (updates ?? []).filter((u) => u.published_at);
  const lastPublished = publishedUpdates.length > 0 ? publishedUpdates[0].published_at : null;
  const daysSinceLastUpdate = lastPublished
    ? Math.floor((Date.now() - new Date(lastPublished).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return NextResponse.json({
    files: files ?? [],
    variations: variations ?? [],
    signature_requests: signatureRequests ?? [],
    updates: updates ?? [],
    photo_count: photos?.length ?? 0,
    cadence: {
      last_published_at: lastPublished,
      days_since_last_update: daysSinceLastUpdate,
      // BUILD-SPEC.md "Fortnightly cadence hint: ... amber >14 days."
      stale: daysSinceLastUpdate !== null ? daysSinceLastUpdate > 14 : true,
    },
  });
}
