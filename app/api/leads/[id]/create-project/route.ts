import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { Lead, Project } from "@/types";

export const runtime = "nodejs";

/**
 * POST /api/leads/[id]/create-project
 * Admin-only. BUILD-SPEC.md "Moving a lead to Design Work In Progress
 * offers one-click 'Create project' (links lead -> project)":
 *   - name        <- leads.surname_project
 *   - client_name <- leads.first_name + surname_project (best-effort;
 *                    falls back to surname_project alone if no first
 *                    name is on file)
 *   - address     <- leads.location
 * Stores project_id on the lead AND the reverse lead_id on the new
 * project ("links both ways"). Idempotent: if the lead already has a
 * project_id, returns the existing project rather than creating a
 * second one (409 avoided — a re-click of "Create project" after a
 * page refresh should never double-create).
 *
 * Does NOT require the lead to currently be in "Design Work In
 * Progress" — the button is surfaced by the UI only at that stage
 * (per the spec's "offers one-click" phrasing describing the UI
 * affordance, not a hard state-machine rule), but the route itself
 * stays a simple, reusable "make a project from this lead" action so
 * an admin correcting an out-of-order lead isn't blocked.
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can create projects from leads" }, { status: 403 });
  }

  const { data: lead, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", id)
    .is("deleted_at", null)
    .single();

  if (leadError || !lead) {
    return NextResponse.json({ error: "Lead not found" }, { status: 404 });
  }

  const typedLead = lead as Lead;

  if (typedLead.project_id) {
    const { data: existingProject, error: existingError } = await supabase
      .from("projects")
      .select("*")
      .eq("id", typedLead.project_id)
      .maybeSingle();
    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    if (existingProject) {
      return NextResponse.json({ project: existingProject as Project, lead: typedLead });
    }
    // project_id pointed at a since-deleted/missing project — fall
    // through and create a fresh one rather than erroring out.
  }

  const clientName = typedLead.first_name
    ? `${typedLead.first_name} ${typedLead.surname_project}`.trim()
    : typedLead.surname_project;

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .insert({
      name: typedLead.surname_project,
      client_name: clientName,
      address: typedLead.location || null,
      lead_id: typedLead.id,
      created_by: info.userId,
    })
    .select()
    .single();

  if (projectError) {
    return NextResponse.json({ error: projectError.message }, { status: 500 });
  }

  const { data: updatedLead, error: linkError } = await supabase
    .from("leads")
    .update({ project_id: project.id })
    .eq("id", id)
    .select()
    .single();

  if (linkError) {
    // The project now exists but the back-link failed to save — surface
    // this clearly rather than silently losing the link; the caller can
    // retry (the idempotency check above will pick up the existing
    // project next time once project_id is retried/reset).
    return NextResponse.json(
      { error: `Project created, but failed to link it back to the lead: ${linkError.message}`, project },
      { status: 500 }
    );
  }

  return NextResponse.json(
    { project: project as Project, lead: updatedLead as Lead },
    { status: 201 }
  );
}
