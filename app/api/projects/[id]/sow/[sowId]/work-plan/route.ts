import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import {
  buildSowWorkPlan,
  type ExistingSowWorkTask,
  type SowWorkPlanContactAssignment,
  type SowWorkPlanPhase,
  type SowWorkPlanSourceSection,
} from "@/lib/sow-work-plan";
import type {
  ApplySowWorkPlanInput,
  ApplySowWorkPlanResponse,
  SowWorkPlanPreviewResponse,
} from "@/types/sow-work-plan";

type RouteParams = { params: Promise<{ id: string; sowId: string }> };

interface WorkPlanContext {
  preview: SowWorkPlanPreviewResponse;
}

function contactLabel(value: unknown): string | null {
  const contact = Array.isArray(value) ? value[0] : value;
  if (!contact || typeof contact !== "object") return null;
  const row = contact as { company?: unknown; contact_name?: unknown };
  const company = typeof row.company === "string" ? row.company.trim() : "";
  const name = typeof row.contact_name === "string" ? row.contact_name.trim() : "";
  return company || name || null;
}

async function loadWorkPlanContext(
  supabase: SupabaseClient,
  projectId: string,
  sowId: string
): Promise<WorkPlanContext | { error: string; status: number }> {
  const { data: sow, error: sowError } = await supabase
    .from("sow_documents")
    .select("id,project_id,revision_label")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .maybeSingle();
  if (sowError) return { error: sowError.message, status: 500 };
  if (!sow) return { error: "Scope of Works revision not found", status: 404 };

  const [sectionsResult, groupsResult, tasksResult, assignmentsResult] = await Promise.all([
    supabase
      .from("sow_sections")
      .select("id,heading,sort,sow_lines(id,text,kind,trade,sort)")
      .eq("sow_id", sowId)
      .order("sort", { ascending: true }),
    supabase
      .from("board_groups")
      .select("id,name,sort")
      .eq("project_id", projectId)
      .order("sort", { ascending: true }),
    supabase
      .from("board_tasks")
      .select("id,title,phase_group_id,trade_role,sow_work_key,sow_revision_id,board_task_sow_lines(sow_line_id)")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("project_trade_assignments")
      .select("trade_role,contact:contacts!project_trade_assignments_contact_id_fkey(company,contact_name)")
      .eq("project_id", projectId),
  ]);

  const firstError =
    sectionsResult.error ?? groupsResult.error ?? tasksResult.error ?? assignmentsResult.error;
  if (firstError) return { error: firstError.message, status: 500 };

  const sections = (sectionsResult.data ?? []).map((section) => {
    const row = section as unknown as {
      id: string;
      heading: string;
      sow_lines: SowWorkPlanSourceSection["lines"];
    };
    return {
      id: row.id,
      heading: row.heading,
      lines: [...(row.sow_lines ?? [])].sort(
        (a, b) =>
          ((a as SowWorkPlanSourceSection["lines"][number] & { sort?: number }).sort ?? 0) -
          ((b as SowWorkPlanSourceSection["lines"][number] & { sort?: number }).sort ?? 0)
      ),
    } satisfies SowWorkPlanSourceSection;
  });
  const phases: SowWorkPlanPhase[] = (groupsResult.data ?? []).map((group) => ({
    group_id: group.id as string,
    name: group.name as string,
    sort: group.sort as number,
  }));
  const existingTasks: ExistingSowWorkTask[] = (tasksResult.data ?? []).map((task) => {
    const row = task as unknown as {
      id: string;
      title: string;
      phase_group_id: string | null;
      trade_role: string | null;
      sow_work_key: string | null;
      sow_revision_id: string | null;
      board_task_sow_lines: { sow_line_id: string }[] | null;
    };
    return {
      id: row.id,
      title: row.title,
      phase_group_id: row.phase_group_id,
      trade_role: row.trade_role,
      sow_work_key: row.sow_work_key,
      sow_revision_id: row.sow_revision_id,
      linked_sow_line_ids: (row.board_task_sow_lines ?? []).map((link) => link.sow_line_id),
    };
  });
  const assignments: SowWorkPlanContactAssignment[] = (assignmentsResult.data ?? []).map(
    (assignment) => ({
      trade_role: assignment.trade_role as string,
      contact_name: contactLabel(
        (assignment as unknown as { contact?: unknown }).contact
      ),
    })
  );

  const result = buildSowWorkPlan({
    sowId,
    sections,
    phases,
    existingTasks,
    assignments,
  });
  const preview: SowWorkPlanPreviewResponse = {
    sow_id: sowId,
    revision_label: sow.revision_label as string,
    suggestions: result.suggestions,
    summary: {
      scope_inclusions: result.scopeInclusionCount,
      included_lines: result.includedLineCount,
      untagged_inclusions: result.untaggedInclusionCount,
      unplanned_packages: result.suggestions.filter((row) => row.phase_group_id === null).length,
      current_packages: result.suggestions.filter((row) => row.state === "current").length,
      proposed_changes: result.suggestions.filter((row) => row.state !== "current").length,
    },
  };
  return { preview };
}

/**
 * GET returns a review-only Scope → Work Plan preview. It never creates or
 * changes a board task. Detailed room clauses are deliberately rolled up into
 * one package per phase/trade, and existing template/manual tasks are matched
 * conservatively so the preview favours linking over duplication.
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const context = await loadWorkPlanContext(supabase, projectId, sowId);
  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }
  return NextResponse.json(context.preview);
}

/**
 * POST applies only the checked preview rows. Each package is committed by one
 * database function call, making that package atomic and retry-safe. Existing
 * task content and manually-selected phases/contacts are preserved.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let parsedBody: unknown;
  try {
    parsedBody = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!parsedBody || typeof parsedBody !== "object") {
    return NextResponse.json({ error: "selections must be an array" }, { status: 400 });
  }
  const selections = (parsedBody as Partial<ApplySowWorkPlanInput>).selections;
  if (!Array.isArray(selections)) {
    return NextResponse.json({ error: "selections must be an array" }, { status: 400 });
  }
  const requestedSelections = selections.filter(
    (selection) =>
      selection &&
      typeof selection.key === "string" &&
      typeof selection.fingerprint === "string"
  );
  const requestedKeys = [...new Set(requestedSelections.map((selection) => selection.key))];
  if (
    requestedSelections.length !== selections.length ||
    requestedKeys.length !== requestedSelections.length ||
    requestedKeys.length === 0 ||
    requestedKeys.length > 100
  ) {
    return NextResponse.json(
      { error: "Choose between 1 and 100 work-plan suggestions" },
      { status: 400 }
    );
  }

  const context = await loadWorkPlanContext(supabase, projectId, sowId);
  if ("error" in context) {
    return NextResponse.json({ error: context.error }, { status: context.status });
  }
  const suggestionsByKey = new Map(
    context.preview.suggestions.map((suggestion) => [suggestion.key, suggestion])
  );
  const unknownKeys = requestedKeys.filter((key) => !suggestionsByKey.has(key));
  const changedKeys = requestedSelections
    .filter((selection) => suggestionsByKey.get(selection.key)?.fingerprint !== selection.fingerprint)
    .map((selection) => selection.key);
  if (unknownKeys.length > 0 || changedKeys.length > 0) {
    return NextResponse.json(
      { error: "The Scope or Work Plan changed after this preview. Review it again before applying." },
      { status: 409 }
    );
  }
  const unplannedKeys = requestedKeys.filter(
    (key) => suggestionsByKey.get(key)?.phase_group_id === null
  );
  if (unplannedKeys.length > 0) {
    return NextResponse.json(
      { error: "Each selected package needs a Work phase before it can be applied." },
      { status: 409 }
    );
  }

  const result: ApplySowWorkPlanResponse = {
    created_count: 0,
    linked_count: 0,
    refreshed_count: 0,
    skipped_count: 0,
  };

  for (const key of requestedKeys) {
    const suggestion = suggestionsByKey.get(key)!;
    if (suggestion.state === "current") {
      result.skipped_count += 1;
      continue;
    }
    const { data, error } = await supabase.rpc("apply_sow_work_plan_package", {
      p_project_id: projectId,
      p_sow_id: sowId,
      p_work_key: suggestion.key,
      p_title: suggestion.title,
      p_trade_role: suggestion.trade_role,
      p_phase_group_id: suggestion.phase_group_id,
      p_line_ids: suggestion.line_ids,
      p_existing_task_id: suggestion.existing_task_id,
    });
    if (error) {
      return NextResponse.json(
        {
          error: error.message,
          partial_result: result,
          detail: "Completed packages remain safe; review the refreshed preview before retrying.",
        },
        { status: 500 }
      );
    }
    const outcome = (data as { outcome?: string }[] | null)?.[0]?.outcome;
    if (outcome === "created") result.created_count += 1;
    else if (outcome === "linked") result.linked_count += 1;
    else if (outcome === "refreshed") result.refreshed_count += 1;
    else result.skipped_count += 1;
  }

  return NextResponse.json(result);
}
