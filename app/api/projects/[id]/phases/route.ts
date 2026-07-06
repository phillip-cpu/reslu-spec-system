import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { namesMatch } from "@/lib/phase-template";
import { seedPhaseTemplateIfEmpty } from "@/lib/phase-seed";
import type { CreatePhaseInput } from "@/types";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, VisitContactSummary } from "@/lib/trade-visits";
import type { SchedulePhaseWithBoardGroup } from "@/types/phase-fix-a";

const VALID_COLORS = new Set(["sand", "charcoal", "teal", "amber"]);
const SORT_STEP = 1000;
const UMBRELLA_SECTION_NAME_MATCH = "preliminaries & site";
const NEEDS_DATES_PREFIX = "[unification: needs dates]";

type PhaseRow = SchedulePhaseWithVisits & { kind: "phase" | "umbrella"; cost_section_id: string | null };

/**
 * GET /api/projects/[id]/phases
 * Team-visible (scheduling data, not financial). Response:
 * { phases: SchedulePhaseWithVisits[] } (each row also carries
 * board_group_id/needs_dates — see SchedulePhaseWithBoardGroup,
 * types/phase-fix-a.ts), non-deleted, sorted, each annotated with a
 * lightweight contact summary (batched lookup, not N+1) AND its
 * non-deleted trade_visits (also batched, each visit carrying its own
 * lightweight contact summary).
 *
 * ============================================================
 * FIX ROUND A — Phase unification + shared seed path + umbrella fix.
 * This replaces Phase 11A's original recompute-on-read umbrella logic
 * wholesale. Read this doc comment in full before touching this file
 * again; the invariant below is now the single source of truth for
 * how schedule_phases and board_groups relate.
 * ============================================================
 *
 * THE INVARIANT (BUILD-SPEC.md "Timeline vs Board roles feel clunky" /
 * "UNIFY phases"): schedule_phases and board_groups are now ONE
 * concept, rendered two ways (Timeline = phases with dates; Board
 * Grouped-list = the same phases as task-group headers).
 * schedule_phases.name is the single source of truth for a unified
 * phase's label; board_groups.name is a synced MIRROR (kept for
 * backward-compatible reads — see migration 023's column comment).
 * board_groups.phase_id (migration 023) is the link. Henceforth:
 *   - POST here (creating a phase) ALSO creates a linked board_groups
 *     row (see POST below).
 *   - POST /api/projects/[id]/board/groups (creating a group) ALSO
 *     creates a linked schedule_phases row (see that route, updated
 *     in this task).
 *   - PATCH /api/phases/[id] renaming a phase ALSO updates the linked
 *     board_groups.name (see that route).
 *   - PATCH /api/board-groups/[id] renaming a group ALSO updates the
 *     linked schedule_phases.name, when linked (see that route).
 * A row on either side with no link (phase_id / linked board_groups
 * row absent) is legacy/unreconciled data — migration 023's one-time
 * backfill matched everything it could by case-insensitive name and
 * created a schedule_phases row for anything left over, so this
 * should be rare going forward, but the API layer never assumes every
 * board_groups row has a phase_id.
 *
 * SHARED SEED PATH (BUILD-SPEC.md "Pre-populated phases"): "phase
 * template seeded on first Timeline OR Board-grouped visit (shared
 * seed path)". Both this GET (first Timeline API load) and
 * POST /api/projects/[id]/board/groups/seed (first Board Grouped-list
 * visit) — plus app/(dashboard)/projects/[id]/timeline/page.tsx (first
 * Timeline PAGE load) — now seed via the SAME function,
 * lib/phase-seed.ts's seedPhaseTemplateIfEmpty(), which reads the
 * editable app_settings('phase_template') row (falls back to
 * FALLBACK_PHASE_TEMPLATE if that row is somehow missing). Seeding is
 * idempotent per project: it only runs if the project currently has
 * ZERO non-deleted schedule_phases rows, mirroring board_columns'
 * existing "seed only if empty" pattern.
 *
 * UMBRELLA FIX (BUILD-SPEC.md "Site Setup umbrella span" item 3): the
 * OLD behaviour recomputed the umbrella's start_date/end_date to
 * min/max of every ordinary phase on EVERY GET — "auto-spans the
 * project's first to last scheduled phase date" — which Phillip's
 * testing flagged as wrong (it visually spanned the WHOLE project,
 * not "the first few days of setup"). That recompute is REMOVED
 * entirely. The umbrella phase is now an ordinary, user-editable
 * schedule_phases row in every respect except:
 *   (a) it is only ever CREATED by the shared seed path (never
 *       directly POSTable — kind is still never client-settable, see
 *       POST below), with its default span computed ONCE at seed time
 *       by lib/phase-template.ts's computeUmbrellaSeedSpan()
 *       (project's earliest phase start, or today if there are no
 *       other phases yet, plus 4 days);
 *   (b) its cost_section_id binding to "Preliminaries & Site" (for the
 *       read-only content tooltip) is still refreshed on every GET —
 *       that binding is a link, not a date, and the spec explicitly
 *       keeps it ("still bound to Preliminaries & Site content");
 *   (c) it still never gets trade_visits/trade emails (enforced by
 *       POST /api/projects/[id]/visits' existing kind==='umbrella'
 *       400, untouched by this task).
 * PATCH /api/phases/[id] (updated in this task) no longer blocks
 * name/start_date/end_date edits on umbrella-kind rows — they're
 * editable like any normal phase now.
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

  await seedPhaseTemplateIfEmpty(supabase, projectId);

  // ---- Preliminaries & Site cost-section binding refresh (link
  // only — NOT dates, see doc comment above) ----
  const { data: sections } = await supabase
    .from("cost_sections")
    .select("id,name")
    .eq("project_id", projectId);

  const prelimSection = (sections ?? []).find(
    (s) => s.name.trim().toLowerCase() === UMBRELLA_SECTION_NAME_MATCH
  );

  let sectionHasLines = false;
  if (prelimSection) {
    const { count } = await supabase
      .from("cost_lines")
      .select("id", { count: "exact", head: true })
      .eq("section_id", prelimSection.id)
      .is("deleted_at", null);
    sectionHasLines = (count ?? 0) > 0;
  }

  const { data: existingUmbrella } = await supabase
    .from("schedule_phases")
    .select("id,cost_section_id")
    .eq("project_id", projectId)
    .eq("kind", "umbrella")
    .is("deleted_at", null)
    .maybeSingle();

  if (existingUmbrella) {
    const nextSectionId = prelimSection && sectionHasLines ? prelimSection.id : null;
    if (existingUmbrella.cost_section_id !== nextSectionId) {
      await supabase
        .from("schedule_phases")
        .update({ cost_section_id: nextSectionId })
        .eq("id", existingUmbrella.id);
    }
  }
  // Note: unlike the old behaviour, a missing/emptied "Preliminaries &
  // Site" section no longer soft-deletes the umbrella phase — the
  // umbrella is now real, user-owned scheduling data (it may have
  // visits, notes, a moved date range the team set deliberately), not
  // a purely-derived band. Losing its content binding just means the
  // read-only tooltip has nothing to show; the phase itself stays.

  // ---- Main select ----
  const { data: phases, error } = await supabase
    .from("schedule_phases")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const phaseRows = (phases ?? []) as PhaseRow[];

  const contactIds = [...new Set(phaseRows.map((p) => p.contact_id).filter(Boolean))] as string[];
  const { data: contacts } = contactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", contactIds)
    : { data: [] as VisitContactSummary[] };
  const contactById = new Map((contacts ?? []).map((c) => [c.id, c]));

  // ---- Batch-fetch non-deleted trade_visits for every phase (not N+1) ----
  const phaseIds = phaseRows.map((p) => p.id);
  const { data: visits } = phaseIds.length
    ? await supabase
        .from("trade_visits")
        .select("*")
        .in("phase_id", phaseIds)
        .is("deleted_at", null)
        .order("start_date", { ascending: true })
    : { data: [] as (TradeVisitWithContact & { contact_id: string | null })[] };

  const visitContactIds = [...new Set((visits ?? []).map((v) => v.contact_id).filter(Boolean))] as string[];
  const { data: visitContacts } = visitContactIds.length
    ? await supabase.from("contacts").select("id,company,contact_name").in("id", visitContactIds)
    : { data: [] as VisitContactSummary[] };
  const visitContactById = new Map((visitContacts ?? []).map((c) => [c.id, c]));

  const visitsByPhase = new Map<string, TradeVisitWithContact[]>();
  for (const v of visits ?? []) {
    const withContact: TradeVisitWithContact = {
      ...v,
      contact: v.contact_id ? visitContactById.get(v.contact_id) ?? null : null,
    };
    const list = visitsByPhase.get(v.phase_id) ?? [];
    list.push(withContact);
    visitsByPhase.set(v.phase_id, list);
  }

  // ---- cost_section_lines for the umbrella phase (descriptions only) ----
  let costSectionLines: string[] = [];
  const umbrellaRow = phaseRows.find((p) => p.kind === "umbrella");
  if (umbrellaRow?.cost_section_id) {
    const { data: lines } = await supabase
      .from("cost_lines")
      .select("description")
      .eq("section_id", umbrellaRow.cost_section_id)
      .is("deleted_at", null)
      .order("sort", { ascending: true });
    costSectionLines = (lines ?? []).map((l) => l.description);
  }

  // ---- board_group linkage (unification) ----
  const { data: linkedGroups } = phaseIds.length
    ? await supabase.from("board_groups").select("id,phase_id").in("phase_id", phaseIds)
    : { data: [] as { id: string; phase_id: string | null }[] };
  const groupIdByPhaseId = new Map((linkedGroups ?? []).map((g) => [g.phase_id as string, g.id]));

  const result: (SchedulePhaseWithVisits & Partial<SchedulePhaseWithBoardGroup>)[] = phaseRows.map((p) => ({
    ...p,
    contact: p.contact_id ? contactById.get(p.contact_id) ?? null : null,
    visits: visitsByPhase.get(p.id) ?? [],
    board_group_id: groupIdByPhaseId.get(p.id) ?? null,
    needs_dates: !!p.notes && p.notes.startsWith(NEEDS_DATES_PREFIX),
    ...(p.kind === "umbrella" ? { cost_section_lines: costSectionLines } : {}),
  }));

  return NextResponse.json({ phases: result });
}

/**
 * POST /api/projects/[id]/phases
 * body: CreatePhaseInput — { name, start_date, end_date, color_key?,
 * contact_id?, notes? }. Response: { phase } (201). end_date >=
 * start_date is enforced both here (400, friendly message) and by the
 * DB check constraint (chk_schedule_phases_dates in migration 013) as
 * a second line of defence. `sort` = server-computed max(existing) +
 * SORT_STEP.
 *
 * `kind` is NEVER accepted from the client — every phase created
 * through this route is kind='phase' (the DB column default).
 * Umbrella phases are exclusively created by the shared seed path
 * (lib/phase-seed.ts's seedPhaseTemplateIfEmpty); there is deliberately
 * no client-facing way to create one directly.
 *
 * UNIFICATION INVARIANT (Fix Round A): every phase created here ALSO
 * gets a linked board_groups row (same name, phase_id set) — unless a
 * board_groups row with a case-insensitively matching name already
 * exists and is unlinked, in which case THAT row is linked instead of
 * creating a duplicate group (mirrors migration 023's one-time
 * backfill matching rule via lib/phase-template.ts's namesMatch(), so
 * a team member who already renamed/created a board group by hand
 * before creating "the same" phase from the Timeline doesn't end up
 * with two groups for one phase).
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

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: CreatePhaseInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name?.trim() || !body.start_date || !body.end_date) {
    return NextResponse.json(
      { error: "name, start_date and end_date are required" },
      { status: 400 }
    );
  }
  if (body.end_date < body.start_date) {
    return NextResponse.json(
      { error: "end_date must be on or after start_date" },
      { status: 400 }
    );
  }
  const colorKey = body.color_key ?? "sand";
  if (!VALID_COLORS.has(colorKey)) {
    return NextResponse.json(
      { error: "color_key must be one of sand, charcoal, teal, amber" },
      { status: 400 }
    );
  }

  const { data: maxRow } = await supabase
    .from("schedule_phases")
    .select("sort")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;
  const trimmedName = body.name.trim();

  const { data: phase, error } = await supabase
    .from("schedule_phases")
    .insert({
      project_id: projectId,
      name: trimmedName,
      start_date: body.start_date,
      end_date: body.end_date,
      color_key: colorKey,
      contact_id: body.contact_id || null,
      notes: body.notes?.trim() || null,
      sort: nextSort,
      // kind intentionally omitted — DB default 'phase' applies.
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  // ---- Unification invariant: create/link the board_groups row ----
  const { data: existingGroups } = await supabase
    .from("board_groups")
    .select("id,name,phase_id")
    .eq("project_id", projectId)
    .is("phase_id", null);

  const matchingUnlinked = (existingGroups ?? []).find((g) => namesMatch(g.name, trimmedName));

  if (matchingUnlinked) {
    await supabase.from("board_groups").update({ phase_id: phase.id }).eq("id", matchingUnlinked.id);
  } else {
    const { data: maxGroupSort } = await supabase
      .from("board_groups")
      .select("sort")
      .eq("project_id", projectId)
      .order("sort", { ascending: false })
      .limit(1)
      .maybeSingle();
    await supabase.from("board_groups").insert({
      project_id: projectId,
      name: trimmedName,
      sort: (maxGroupSort?.sort ?? -SORT_STEP) + SORT_STEP,
      phase_id: phase.id,
    });
  }

  return NextResponse.json({ phase }, { status: 201 });
}
