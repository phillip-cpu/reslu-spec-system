import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { projectRollup, sectionRollup, ffeRollup, wholeJobSummary } from "@/lib/estimate";
import { TRACKED_DOCUMENT_KINDS, documentStatusFor } from "@/lib/sow";
import type {
  ApprovalEvent,
  CostSectionWithLines,
  Project,
  ProjectFile,
  ProjectFileKind,
  ProjectOverviewResponse,
} from "@/types";

/**
 * GET /api/projects/[id]/overview
 * Backs the Overview tab (BUILD-SPEC.md "Project overview hub"): FF&E
 * counts, per-kind document traffic lights + latest revision, an
 * estimate summary (admin only), and the last ~5 client approval
 * events. Computed server-side so the client never re-derives rollups
 * from raw tables itself, and so the financial gate (estimate) can
 * never leak by a UI oversight — the field is simply absent from a
 * non-admin response, same "field-stripping over UI-hiding" rule as
 * every other financial surface in this codebase.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const isAdmin = info.role === "admin";

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("*")
    .eq("id", projectId)
    .single();
  if (projectError || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }
  const typedProject = project as Project;

  const [
    { data: items, error: itemsError },
    { data: files, error: filesError },
    { data: approvalEvents, error: approvalError },
  ] = await Promise.all([
    supabase
      .from("items")
      .select("id, status, client_approved, client_flagged, category, quantity, price_trade, price_rrp")
      .eq("project_id", projectId)
      .is("deleted_at", null),
    supabase
      .from("project_files")
      .select("kind, revision_label, uploaded_at")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: false }),
    // approval_events has no project_id column — it hangs off items —
    // so recent client activity is fetched via an inner join through
    // items, scoped to this project, newest first, capped at 5 per the
    // build spec ("last ~5 approval_events with item codes + relative
    // dates"). item_code/name are pulled from the nested items row for
    // display; the join also naturally scopes results to non-deleted
    // items only is NOT guaranteed (deleted items' history should still
    // show, matching the audit-trail intent of approval_events) — no
    // deleted_at filter applied here on purpose.
    supabase
      .from("approval_events")
      .select("*, items!inner(project_id, item_code, name)")
      .eq("items.project_id", projectId)
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  if (itemsError) {
    return NextResponse.json({ error: itemsError.message }, { status: 500 });
  }
  if (filesError) {
    return NextResponse.json({ error: filesError.message }, { status: 500 });
  }
  if (approvalError) {
    return NextResponse.json({ error: approvalError.message }, { status: 500 });
  }

  // ---- FF&E card ----
  const ffe = {
    item_count: items?.length ?? 0,
    approved_count: (items ?? []).filter((it) => it.client_approved).length,
    flagged_count: (items ?? []).filter((it) => it.client_flagged).length,
    ordered_count: (items ?? []).filter((it) =>
      ["Ordered", "On Site", "Installed"].includes(it.status)
    ).length,
  };

  // ---- Documents card: per-kind traffic light + latest revision ----
  const filesByKind = new Map<ProjectFileKind, ProjectFile[]>();
  for (const f of (files ?? []) as ProjectFile[]) {
    const list = filesByKind.get(f.kind);
    if (list) list.push(f);
    else filesByKind.set(f.kind, [f]);
  }
  const documents = TRACKED_DOCUMENT_KINDS.map((kind) => {
    const kindFiles = filesByKind.get(kind) ?? [];
    // Already ordered uploaded_at desc by the query above.
    const latest = kindFiles[0];
    return {
      kind,
      status: documentStatusFor(typedProject.document_status, kind),
      latest_revision_label: latest?.revision_label ?? null,
    };
  });

  // ---- Estimate card (admin only — financial data) ----
  let estimate: ProjectOverviewResponse["estimate"] = null;
  if (isAdmin) {
    const [
      { data: sections, error: sectionsError },
      { data: variations, error: variationsError },
    ] = await Promise.all([
      supabase
        .from("cost_sections")
        .select("*, cost_lines(*)")
        .eq("project_id", projectId),
      supabase
        .from("variations")
        .select("status, cost_ex_gst")
        .eq("project_id", projectId)
        .is("deleted_at", null),
    ]);
    if (sectionsError) {
      return NextResponse.json({ error: sectionsError.message }, { status: 500 });
    }
    if (variationsError) {
      return NextResponse.json({ error: variationsError.message }, { status: 500 });
    }

    const sectionsWithLines: CostSectionWithLines[] = (sections ?? []).map((section) => {
      const lines = (
        (section as unknown as { cost_lines: CostSectionWithLines["lines"] }).cost_lines ?? []
      ).filter((l) => !l.deleted_at);
      return { ...(section as unknown as CostSectionWithLines), lines, rollup: sectionRollup(lines) };
    });
    const allLines = sectionsWithLines.flatMap((s) => s.lines);
    const rollup = projectRollup({
      lines: allLines,
      variations: variations ?? [],
      markupPct: typedProject.estimate_markup_pct ?? 0,
    });
    const ffeForEstimate = ffeRollup(
      (items ?? []).map((it) => ({
        id: it.id,
        category: it.category,
        quantity: it.quantity,
        price_trade: it.price_trade,
        price_rrp: it.price_rrp,
      }))
    );
    const wholeJob = wholeJobSummary(rollup, ffeForEstimate);

    const percentQuoted =
      rollup.totalToClientExGst > 0
        ? Math.round((rollup.quotedExGst / rollup.totalToClientExGst) * 100)
        : 0;

    estimate = {
      total_inc_gst: wholeJob.combinedIncGst,
      percent_quoted: percentQuoted,
      variance:
        rollup.quotedExGst > 0 || rollup.actualExGst > 0
          ? Math.round((rollup.quotedExGst - rollup.actualExGst) * 100) / 100
          : null,
    };
  }

  // ---- Client activity card ----
  const clientActivity = (approvalEvents ?? []).map((ev) => {
    const raw = ev as ApprovalEvent & {
      items: { project_id: string; item_code: string; name: string } | null;
    };
    const { items: joinedItem, ...rest } = raw;
    return {
      ...(rest as ApprovalEvent),
      item_code: joinedItem?.item_code ?? null,
      item_name: joinedItem?.name ?? null,
    };
  });

  const payload: ProjectOverviewResponse = {
    project: typedProject,
    ffe,
    documents,
    estimate,
    client_activity: clientActivity,
  };

  return NextResponse.json(payload);
}
