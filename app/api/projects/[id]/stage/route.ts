import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadProjectCloseoutReadiness } from "@/lib/project-closeout-server";
import { projectStatusForStage } from "@/lib/project-lifecycle";
import { createClient } from "@/lib/supabase/server";
import { PROJECT_STAGES, type ProjectStage } from "@/types/finance";
import type { ProjectStatus } from "@/types";

export const runtime = "nodejs";

type StageRequest = {
  stage?: ProjectStage;
  expected_updated_at?: string;
  closeout_acknowledged?: boolean;
};

/** PATCH /api/projects/[id]/stage — the single guarded job-lifecycle transition. */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can change the job stage" }, { status: 403 });
  }

  let body: StageRequest;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.stage || !PROJECT_STAGES.includes(body.stage)) {
    return NextResponse.json({ error: "Choose a valid job stage" }, { status: 400 });
  }

  const { data: current, error: readError } = await supabase
    .from("projects")
    .select("id,status,project_stage,updated_at")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: readError.message }, { status: 500 });
  if (!current) return NextResponse.json({ error: "Project not found" }, { status: 404 });
  if (current.status === "archived") {
    return NextResponse.json({ error: "Restore the archived project before changing its stage" }, { status: 409 });
  }
  if (body.expected_updated_at && body.expected_updated_at !== current.updated_at) {
    return NextResponse.json(
      { error: "The project changed since this stage was loaded. Refresh and try again." },
      { status: 409 }
    );
  }

  if (body.stage === "complete") {
    if (current.project_stage !== "handover") {
      return NextResponse.json(
        {
          code: "closeout_handover_required",
          error: "Move the job to Handover and review closeout before finalising it.",
        },
        { status: 409 }
      );
    }

    try {
      const readiness = await loadProjectCloseoutReadiness(supabase, id);
      if (!readiness.ready && body.closeout_acknowledged !== true) {
        return NextResponse.json(
          {
            code: "closeout_review_required",
            error: "Review and acknowledge the outstanding closeout areas before finalising.",
            readiness,
          },
          { status: 409 }
        );
      }
    } catch (error) {
      return NextResponse.json(
        {
          error:
            error instanceof Error
              ? error.message
              : "Could not verify closeout readiness",
        },
        { status: 500 }
      );
    }
  }

  const status = projectStatusForStage(body.stage, current.status as ProjectStatus);
  const { data: project, error: updateError } = await supabase
    .from("projects")
    .update({ project_stage: body.stage, status })
    .eq("id", id)
    .eq("updated_at", current.updated_at)
    .select("id,status,project_stage,updated_at")
    .maybeSingle();
  if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 });
  if (!project) {
    return NextResponse.json(
      { error: "The project changed while its stage was being updated. Refresh and try again." },
      { status: 409 }
    );
  }

  return NextResponse.json({ project });
}
