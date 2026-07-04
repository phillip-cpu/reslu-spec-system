import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isAdmin } from "@/lib/auth";
import type { ProfileRole } from "@/types";

const VALID_ROLES = new Set<ProfileRole>(["admin", "designer", "viewer"]);

/**
 * PATCH /api/profiles/[id]
 * body: { role: 'admin' | 'designer' | 'viewer' }
 *
 * Admin-only (BUILD-SPEC.md §Settings: "Role assignment lives in
 * Settings, admin-only"). Refuses to demote the caller if they are the
 * last remaining admin — otherwise a single click could lock every
 * admin-gated feature (financial fields, category management, project
 * archiving, role management itself) with no way back in short of a
 * direct database edit.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const admin = await isAdmin(supabase);
  if (!admin) {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const role = body?.role as ProfileRole | undefined;
  if (!role || !VALID_ROLES.has(role)) {
    return NextResponse.json(
      { error: "role must be one of: admin, designer, viewer" },
      { status: 400 }
    );
  }

  // Last-admin protection: only relevant when the target IS the caller
  // and the caller IS currently an admin being demoted away from it.
  if (id === user.id && role !== "admin") {
    const { count } = await supabase
      .from("profiles")
      .select("*", { count: "exact", head: true })
      .eq("role", "admin");
    if ((count ?? 0) <= 1) {
      return NextResponse.json(
        { error: "Cannot demote yourself — you are the last remaining admin." },
        { status: 400 }
      );
    }
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .update({ role })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!profile) {
    return NextResponse.json({ error: "Profile not found" }, { status: 404 });
  }

  return NextResponse.json({ profile });
}
