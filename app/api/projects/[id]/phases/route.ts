import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { computeUmbrellaBand } from "@/lib/trade-visits";
import type { CreatePhaseInput, PhasesListResponse, SchedulePhaseWithContact } from "@/types";
import type { SchedulePhaseWithVisits, TradeVisitWithContact, VisitContactSummary } from "@/lib/trade-visits";

const VALID_COLORS = new Set(["sand", "charcoal", "teal", "amber"]);
const SORT_STEP = 1000;
const UMBRELLA_NAME = "Site Setup";
const UMBRELLA_SECTION_NAME_MATCH = "preliminaries & site";

type PhaseRow = SchedulePhaseWithContact & { kind: "phase" | "umbrella"; cost_section_id: string | null };

/**
 * GET /api/projects/[id]/phases
 * Team-visible (scheduling data, not financial). Response:
 * { phases: SchedulePhaseWithVisits[] }, non-deleted, sorted, each
 * annotated with a lightweight contact summary (batched lookup, not
 * N+1) AND its non-deleted trade_visits (also batched, each visit
 * carrying its own lightweight contact summary).
 *
 * Umbrella recompute-on-read (Phase 11A / Timeline v2):
 * BUILD-SPEC's "Site Setup" umbrella band represents whole-of-job
 * preliminaries that don't belong to any single phase — it is never
 * created at migration time (see migration 015's doc comment) and
 * never editable by the client directly (see PATCH /api/phases/[id]
 * below). Instead, every GET here:
 *   1. Looks up a cost_sections row for this project whose name
 *      case-insensitively matches "Preliminaries & Site" and has at
 *      least one non-deleted cost_lines row under it.
 *   2. If found: upserts (creates if missing, else updates dates on)
 *      a kind='umbrella' phase whose start_date/end_date are
 *      recomputed to span min(start)/max(end) of every ordinary
 *      'phase'-kind row (lib/trade-visits.ts's computeUmbrellaBand) —
 *      so the band always reflects the CURRENT schedule even as
 *      ordinary phases are added/moved/removed, without a trigger or
 *      cross-table FK coupling into the estimate schema.
 *   3. If not found (no such section, or the section exists but has
 *      zero live lines) and an umbrella phase currently exists for
 *      this project: soft-deletes it.
 *
 * Tradeoff (deliberate): the umbrella band is only ever as fresh as
 * the last GET — if someone deletes every cost line in "Preliminaries
 * & Site" and never reopens the Timeline tab, the umbrella band stays
 * visible (stale) until the next read. This is preferred over the
 * alternative of a DB trigger or foreign-key-driven sync living in
 * this app's estimate module (app/api/estimate/**), which this agent
 * does not own and must not modify — recompute-on-read keeps 100% of
 * the umbrella logic inside this file's boundary.
 *
 * For the umbrella phase specifically, `cost_section_lines` is
 * attached: an array of line DESCRIPTIONS ONLY (no qty/rate/cost
 * fields) from the linked cost section, so the read-only info panel
 * can render without a second fetch and without ever touching
 * pricing data.
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

  // ---- Umbrella recompute-on-read (runs before the main select so
  // the select below picks up any just-created/updated/deleted row) ----
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
    .select("id,start_date,end_date")
    .eq("project_id", projectId)
    .eq("kind", "umbrella")
    .is("deleted_at", null)
    .maybeSingle();

  if (prelimSection && sectionHasLines) {
    const { data: ordinaryPhases } = await supabase
      .from("schedule_phases")
      .select("kind,start_date,end_date")
      .eq("project_id", projectId)
      .eq("kind", "phase")
      .is("deleted_at", null);

    const band = computeUmbrellaBand(
      (ordinaryPhases ?? []).map((p) => ({ kind: "phase" as const, start_date: p.start_date, end_date: p.end_date }))
    );

    if (band) {
      if (existingUmbrella) {
        if (existingUmbrella.start_date !== band.start_date || existingUmbrella.end_date !== band.end_date) {
          await supabase
            .from("schedule_phases")
            .update({ start_date: band.start_date, end_date: band.end_date, cost_section_id: prelimSection.id })
            .eq("id", existingUmbrella.id);
        }
      } else {
        await supabase.from("schedule_phases").insert({
          project_id: projectId,
          name: UMBRELLA_NAME,
          start_date: band.start_date,
          end_date: band.end_date,
          color_key: "charcoal",
          kind: "umbrella",
          cost_section_id: prelimSection.id,
          sort: -SORT_STEP, // umbrella renders first/top — see components/gantt/UmbrellaBand.tsx
        });
      }
    }
    // band === null means there are zero ordinary phases to span yet —
    // leave any existing umbrella row as-is rather than deleting it
    // (it will pick up a correct band the moment a phase exists), and
    // skip creating a new one (nothing to span).
  } else if (existingUmbrella) {
    // No qualifying cost section (missing, renamed, or zero live
    // lines) — the umbrella no longer applies. Soft-delete.
    await supabase
      .from("schedule_phases")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", existingUmbrella.id);
  }

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

  const result: SchedulePhaseWithVisits[] = phaseRows.map((p) => ({
    ...p,
    contact: p.contact_id ? contactById.get(p.contact_id) ?? null : null,
    visits: visitsByPhase.get(p.id) ?? [],
    ...(p.kind === "umbrella" ? { cost_section_lines: costSectionLines } : {}),
  }));

  const body: PhasesListResponse & { phases: SchedulePhaseWithVisits[] } = { phases: result };
  return NextResponse.json(body);
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
 * Umbrella phases are exclusively system-maintained via the
 * recompute-on-read logic in GET above; there is deliberately no
 * client-facing way to create one directly.
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

  const { data: phase, error } = await supabase
    .from("schedule_phases")
    .insert({
      project_id: projectId,
      name: body.name.trim(),
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

  return NextResponse.json({ phase }, { status: 201 });
}
