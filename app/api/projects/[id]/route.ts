import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isProjectType, normaliseProjectSubtype } from "@/lib/project-templates";

/** GET /api/projects/[id] */
export async function GET(
  _request: NextRequest,
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

  const { data: project, error } = await supabase
    .from("projects")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  return NextResponse.json({ project });
}

/** PUT /api/projects/[id] — body: Partial<Project> */
export async function PUT(
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Never allow the client to set these directly.
  delete body.id;
  delete body.client_token;
  delete body.created_at;
  delete body.updated_at;
  // Lifecycle state has its own admin-only, concurrency-guarded route.
  // Silently strip these fields so the generic settings endpoint cannot
  // bypass Handover review or desynchronise project_stage and status.
  delete body.project_stage;
  delete body.status;
  const expectedUpdatedAt = typeof body.expected_updated_at === "string"
    ? body.expected_updated_at.trim()
    : null;
  delete body.expected_updated_at;

  if (Object.keys(body).length === 0) {
    return NextResponse.json({ error: "No project fields supplied" }, { status: 400 });
  }

  if ("project_type" in body || "project_subtype" in body) {
    let projectType = body.project_type;
    if (projectType === undefined) {
      const { data: current } = await supabase
        .from("projects")
        .select("project_type")
        .eq("id", id)
        .maybeSingle();
      projectType = current?.project_type;
    }
    if (!isProjectType(projectType)) {
      return NextResponse.json({ error: "Select a valid project type" }, { status: 400 });
    }
    const projectSubtype = normaliseProjectSubtype(projectType, body.project_subtype);
    if (projectType === "single_room_renovation" && !projectSubtype) {
      return NextResponse.json(
        { error: "Select a room type for a single-room renovation" },
        { status: 400 }
      );
    }
    body.project_type = projectType;
    body.project_subtype = projectSubtype;
  }

  // job_number (migration 028_job_numbers.sql, BUILD-SPEC.md "Three
  // from Phillip — 6 July 2026 evening" item 2): "Overridable in
  // project Settings (unique-checked, 409 on clash)". Validated +
  // pre-checked here (Pattern A, mirroring app/api/items/[id]/route.ts's
  // item_code clash check) rather than relying solely on the DB's
  // partial unique index, so ProjectSettingsForm gets a clean message
  // instead of a raw Postgres error. Empty string clears the field
  // back to null (re-enters the auto-numbered pool).
  if ("job_number" in body) {
    const raw = body.job_number;
    if (raw === "" || raw === null || raw === undefined) {
      body.job_number = null;
    } else if (typeof raw !== "string" || !/^\d{3,4}$/.test(raw)) {
      return NextResponse.json(
        { error: "Job number must be 3 or 4 digits (e.g. 026 or 1024)." },
        { status: 400 }
      );
    } else {
      const { data: clash } = await supabase
        .from("projects")
        .select("id")
        .eq("job_number", raw)
        .is("deleted_at", null)
        .neq("id", id)
        .maybeSingle();
      if (clash) {
        return NextResponse.json(
          { error: `Job number "${raw}" is already used by another project.` },
          { status: 409 }
        );
      }
      body.job_number = raw;
    }
  }

  const updateQuery = supabase
    .from("projects")
    .update(body)
    .eq("id", id);
  const versionedUpdate = expectedUpdatedAt
    ? updateQuery.eq("updated_at", expectedUpdatedAt)
    : updateQuery;
  const { data: project, error } = await versionedUpdate
    .select()
    .maybeSingle();

  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    const message =
      error.code === "23505"
        ? "That job number is already used by another project."
        : error.message;
    return NextResponse.json({ error: message }, { status });
  }
  if (!project) {
    return NextResponse.json(
      { error: expectedUpdatedAt ? "Project changed since it was read; refresh and retry." : "Project not found" },
      { status: expectedUpdatedAt ? 409 : 404 }
    );
  }

  return NextResponse.json({ project });
}

/**
 * DELETE /api/projects/[id]
 * Archives rather than hard-deletes (sets status = 'archived').
 * The UI should describe this action as "Archive", not "Delete" —
 * the DELETE HTTP method is kept for REST convention but the
 * behaviour is non-destructive, per the original brief and the
 * build-spec review (§2.2).
 */
export async function DELETE(
  _request: NextRequest,
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

  const { error } = await supabase
    .from("projects")
    .update({ status: "archived" })
    .eq("id", id);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
