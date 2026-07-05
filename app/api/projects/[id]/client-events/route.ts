import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { ClientEventsResponse, CreateClientEventInput } from "@/types/phase-12a-b";

/**
 * GET /api/projects/[id]/client-events
 * Team-visible (not financial), soonest-first — BUILD-SPEC.md §"Portal
 * — upcoming client meetings": "Team manages from the project client
 * area ... (and Aria via API/MCP create_client_event — she already
 * books meetings)." Returns EVERY non-deleted event (past and future —
 * the team-side list shows history; only the PORTAL page filters to
 * future-only, see app/portal/[token]/page.tsx's client-events query).
 * Aria-relevant.
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

  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: events, error } = await supabase
    .from("client_events")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("starts_at", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const body: ClientEventsResponse = { events: events ?? [] };
  return NextResponse.json(body);
}

/**
 * POST /api/projects/[id]/client-events
 * body: CreateClientEventInput — { title, starts_at (required),
 * ends_at?, location?, notes? }. Response: { event } (201).
 * Aria-relevant (MCP tool create_client_event — she already books
 * meetings per BUILD-SPEC.md).
 */
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

  const { data: project } = await supabase.from("projects").select("id").eq("id", projectId).single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreateClientEventInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title?.trim() || !body.starts_at) {
    return NextResponse.json({ error: "title and starts_at are required" }, { status: 400 });
  }

  if (body.ends_at && new Date(body.ends_at) < new Date(body.starts_at)) {
    return NextResponse.json({ error: "ends_at cannot be before starts_at" }, { status: 400 });
  }

  const { data: event, error } = await supabase
    .from("client_events")
    .insert({
      project_id: projectId,
      title: body.title.trim(),
      starts_at: body.starts_at,
      ends_at: body.ends_at || null,
      location: body.location?.trim() || null,
      notes: body.notes?.trim() || null,
      created_by: user.id,
    })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ event }, { status: 201 });
}
