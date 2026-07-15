import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { normalizeSidebarOrder } from "@/lib/navigation";
import { createClient } from "@/lib/supabase/server";
import type { NavigationPreferencesResponse, RecentProjectShortcut } from "@/types/navigation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function responseFor(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  isAdmin: boolean
): Promise<NavigationPreferencesResponse> {
  const { data: preference } = await supabase
    .from("user_navigation_preferences")
    .select("sidebar_order,recent_project_ids")
    .eq("user_id", userId)
    .maybeSingle();

  const recentIds = Array.isArray(preference?.recent_project_ids)
    ? (preference.recent_project_ids as string[]).slice(0, 3)
    : [];
  const { data: projects } = recentIds.length
    ? await supabase.from("projects").select("id,name").in("id", recentIds).is("deleted_at", null)
    : { data: [] as RecentProjectShortcut[] };
  const projectById = new Map((projects ?? []).map((project) => [project.id, project]));

  return {
    sidebar_order: normalizeSidebarOrder(preference?.sidebar_order, isAdmin),
    recent_projects: recentIds
      .map((id) => projectById.get(id))
      .filter((project): project is RecentProjectShortcut => Boolean(project)),
  };
}

export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(await responseFor(supabase, info.userId, info.role === "admin"));
}

/**
 * PATCH accepts either a full visible sidebar order or one project visit.
 * Project visits are de-duplicated and moved to the front; only the latest
 * three ids are retained. A project must still exist and be non-deleted.
 */
export async function PATCH(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("user_navigation_preferences")
    .select("sidebar_order,recent_project_ids")
    .eq("user_id", info.userId)
    .maybeSingle();

  const update: {
    user_id: string;
    sidebar_order?: string[];
    recent_project_ids?: string[];
  } = { user_id: info.userId };

  if (Array.isArray(body.sidebar_order)) {
    update.sidebar_order = normalizeSidebarOrder(body.sidebar_order, info.role === "admin");
  }

  if (typeof body.visited_project_id === "string") {
    const projectId = body.visited_project_id.trim();
    if (!UUID_RE.test(projectId)) {
      return NextResponse.json({ error: "visited_project_id must be a UUID" }, { status: 400 });
    }
    const { data: project } = await supabase
      .from("projects")
      .select("id")
      .eq("id", projectId)
      .is("deleted_at", null)
      .maybeSingle();
    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    const previous = Array.isArray(existing?.recent_project_ids)
      ? (existing.recent_project_ids as string[])
      : [];
    update.recent_project_ids = [projectId, ...previous.filter((id) => id !== projectId)].slice(0, 3);
  }

  if (!update.sidebar_order && !update.recent_project_ids) {
    return NextResponse.json(
      { error: "sidebar_order or visited_project_id is required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("user_navigation_preferences")
    .upsert(update, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json(await responseFor(supabase, info.userId, info.role === "admin"));
}

