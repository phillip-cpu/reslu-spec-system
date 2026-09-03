import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadProjectCloseoutReadiness } from "@/lib/project-closeout-server";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/** GET /api/projects/[id]/closeout — one derived closeout cockpit. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can review job closeout" },
      { status: 403 }
    );
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (projectError) {
    return NextResponse.json({ error: projectError.message }, { status: 500 });
  }
  if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

  try {
    return NextResponse.json(
      await loadProjectCloseoutReadiness(supabase, projectId)
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Could not load closeout readiness",
      },
      { status: 500 }
    );
  }
}
