import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { applyStageTemplateToEmptyGroups } from "@/lib/phase-seed";

/**
 * POST /api/projects/[id]/board/apply-stage-template
 * Board v3 — Monday parity round. BUILD-SPEC.md "Board v3 — Monday
 * parity" §1: "Existing projects get the same backfill affordance as
 * design templates: 'Apply stage template' banner for empty/sparse
 * boards; must NEVER duplicate tasks." Mirrors
 * POST /api/projects/[id]/design's exact interaction shape
 * (app/api/projects/[id]/design/route.ts) — team auth (not
 * admin-gated; applying a checklist template is ordinary team work,
 * same trust tier as the Design tab's identical action), idempotent.
 *
 * IDEMPOTENCY RULE (documented here, in
 * lib/phase-seed.ts's applyStageTemplateToEmptyGroups() — the actual
 * implementation this route thinly wraps — and in docs/API.md): this
 * endpoint is idempotent PER GROUP, not per board. It walks every
 * board_groups row for this project and fills ONLY the groups that
 * currently have zero non-deleted, TOP-LEVEL (parent_task_id is null)
 * board_tasks — a group that already has at least one top-level task
 * is left completely untouched, even though the BOARD-LEVEL "Apply
 * stage template" banner (components/board/ProjectBoard.tsx) that
 * triggers this POST is shown/hidden based on a DIFFERENT, coarser
 * check: whole-board sparseness (see that component's own doc comment
 * for the precise "sparse = zero tasks across the entire board, not
 * per-group" definition). Practical effect: calling this route twice
 * in a row, or calling it after someone has since manually added a
 * card to one group but not others, never duplicates a single task —
 * it only ever tops up whichever groups are still genuinely empty.
 *
 * Requires board_groups to already exist (i.e. seedPhaseTemplateIfEmpty
 * has run at least once, via the Timeline tab or the Board's Grouped
 * list view) — same "open the [phases/design] tab first" 400 guard
 * POST /api/projects/[id]/design already uses for its own equivalent
 * precondition.
 */
export async function POST(
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

  const { count: groupCount } = await supabase
    .from("board_groups")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (!groupCount) {
    return NextResponse.json(
      { error: "No stage groups yet — open the Board's Grouped list view first" },
      { status: 400 }
    );
  }

  const result = await applyStageTemplateToEmptyGroups(supabase, projectId);

  return NextResponse.json(result);
}
