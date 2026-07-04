import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/projects/[id]/client-updates/posts — list ALL updates
 * (drafts + published) for the team client-area's draft list. Team-
 * authenticated. (The portal's own read of PUBLISHED-only updates is
 * inline in app/portal/[token]/page.tsx, service-role, token-gated —
 * not this route, which requires a session and has no reason to be
 * reachable without one.)
 *
 * POST /api/projects/[id]/client-updates/posts — create a draft
 * (published_at stays null until PATCH .../publish). Body: { title, body_richtext }.
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

  const { data: updates, error } = await supabase
    .from("portal_updates")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ updates: updates ?? [] });
}

export async function POST(
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

  let body: { title?: string; body_richtext?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const title = body.title?.trim();
  const content = body.body_richtext?.trim();
  if (!title || !content) {
    return NextResponse.json({ error: "title and body_richtext are required" }, { status: 400 });
  }

  const { data: row, error } = await supabase
    .from("portal_updates")
    .insert({
      project_id: projectId,
      title,
      body_richtext: content,
      author_id: user.id,
      // published_at stays null — draft until explicitly published.
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ update: row }, { status: 201 });
}
