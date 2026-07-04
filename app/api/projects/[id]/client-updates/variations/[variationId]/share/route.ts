import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";

/**
 * PATCH /api/projects/[id]/client-updates/variations/[variationId]/share
 * Body: { share_to_portal: boolean }
 *
 * BUILD-SPEC.md "Team-side client area": "variation sharing (list
 * variations with share toggle + response status). ... Team access
 * (not admin-only) EXCEPT variation sharing which is admin-only (it
 * exposes client pricing decisions)." — this is the one client-area
 * action in the whole feature that IS admin-gated, enforced here
 * server-side (not merely hidden in the UI), matching the financial-
 * visibility enforcement pattern used for price_trade/markup_pct
 * elsewhere in this codebase.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; variationId: string }> }
) {
  const { id: projectId, variationId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!(await isAdmin(supabase))) {
    return NextResponse.json(
      { error: "Only admins can share variations to the client portal — it exposes client pricing decisions." },
      { status: 403 }
    );
  }

  let body: { share_to_portal?: boolean };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  if (typeof body.share_to_portal !== "boolean") {
    return NextResponse.json({ error: "share_to_portal (boolean) is required" }, { status: 400 });
  }

  const { data: updated, error } = await supabase
    .from("variations")
    .update({ share_to_portal: body.share_to_portal })
    .eq("id", variationId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .select()
    .single();

  if (error || !updated) {
    return NextResponse.json({ error: error?.message ?? "Not found" }, { status: 404 });
  }

  return NextResponse.json({ variation: updated });
}
