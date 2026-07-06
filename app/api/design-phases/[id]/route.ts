import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { PatchDesignPhaseInput } from "@/types/phase-12b";

/**
 * PATCH /api/design-phases/[id]
 * body: PatchDesignPhaseInput — { status?, hinge_dismissed? }.
 * Team access (not admin-gated).
 *
 * Status cycle (BUILD-SPEC.md "status control (not started / in
 * progress / complete / N/A cycle or select)"): `status` is a plain
 * enum write, no state-machine guard (a team member can jump straight
 * from 'not_started' to 'complete' or back again freely) — mirrors this
 * codebase's existing DocumentStatusLight cycle behaviour, which is
 * likewise a free cycle, not a guarded workflow.
 *
 * Side effects on `status`:
 *   - transitioning INTO 'in_progress' for the first time stamps
 *     started_at (if not already set) — a simple "first time this
 *     phase was touched" marker, never cleared once set.
 *   - transitioning INTO 'complete' stamps completed_at; transitioning
 *     OUT of 'complete' (back to any other status) clears completed_at
 *     — mirrors office_tasks' complete/uncomplete symmetry.
 *
 * The WD-Package hinge (BUILD-SPEC.md "completing WD Package prompts
 * SOW + estimate version creation"): no server-side notification is
 * fired here — the hinge is purely a CLIENT-side prompt panel
 * (components/projects/design/WdPackageHingePanel.tsx) that appears
 * whenever the Design tab's already-fetched phase list shows the "WD
 * Package" phase at status 'complete' with hinge_dismissed_at still
 * null (lib/design-framework.ts's shouldShowWdPackageHinge()) — this
 * route's only job for that flow is (a) the status write itself and
 * (b) recording dismissal via `hinge_dismissed: true`, which stamps
 * hinge_dismissed_at so the prompt never nags again for this project.
 * Passing `hinge_dismissed: true` on a phase OTHER than "WD Package" is
 * harmless (the column is simply unused/ignored by the UI elsewhere)
 * but is allowed rather than rejected, since enforcing "only the WD
 * Package row may set this" server-side would require an extra
 * name-lookup for no real safety benefit — the field is meaningless
 * noise on any other row, not a security concern.
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

  const { data: existing } = await supabase
    .from("design_phases")
    .select("id,status,started_at,completed_at")
    .eq("id", id)
    .single();
  if (!existing) {
    return NextResponse.json({ error: "Design phase not found" }, { status: 404 });
  }

  let body: PatchDesignPhaseInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const update: Record<string, unknown> = {};

  if (body.status !== undefined) {
    const validStatuses = ["not_started", "in_progress", "complete", "na"];
    if (!validStatuses.includes(body.status)) {
      return NextResponse.json(
        { error: `status must be one of: ${validStatuses.join(", ")}` },
        { status: 400 }
      );
    }
    update.status = body.status;

    if (body.status === "in_progress" && !existing.started_at) {
      update.started_at = new Date().toISOString();
    }
    if (body.status === "complete") {
      update.completed_at = new Date().toISOString();
    } else if (existing.completed_at) {
      update.completed_at = null;
    }
  }

  if (body.hinge_dismissed !== undefined) {
    update.hinge_dismissed_at = body.hinge_dismissed ? new Date().toISOString() : null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const { data: phase, error } = await supabase
    .from("design_phases")
    .update(update)
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ phase });
}
