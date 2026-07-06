import type { SupabaseClient } from "@supabase/supabase-js";
import { computeUmbrellaSeedSpan, FALLBACK_PHASE_TEMPLATE } from "@/lib/phase-template";
import type { PhaseTaskTemplatesMap } from "@/types/board-cockpit";

const SORT_STEP = 1000;
const TASK_SORT_STEP = 1000;

/**
 * seedPhaseTemplateIfEmpty — the ONE shared seed path (BUILD-SPEC.md
 * "Pre-populated phases": "phase template seeded on first Timeline OR
 * Board-grouped visit (shared seed path)"). Called from THREE places:
 *   - GET /api/projects/[id]/phases (first Timeline API load)
 *   - app/(dashboard)/projects/[id]/timeline/page.tsx (first Timeline
 *     page load — a Server Component, doesn't hit its own API route)
 *   - POST /api/projects/[id]/board/groups/seed (first Board
 *     Grouped-list view visit)
 * All three import THIS function rather than each keeping their own
 * copy, so the seed logic genuinely cannot drift between the two
 * "first visit" surfaces — this replaces what was originally three
 * near-identical inline copies with one.
 *
 * No-ops if the project already has at least one non-deleted
 * schedule_phases row (idempotent per project, mirrors board_columns'
 * existing "seed only if empty" pattern) — so opening BOTH surfaces
 * across a project's life only ever seeds once, and a project someone
 * manually built phases for before either "first visit" happened is
 * never clobbered.
 *
 * Reads app_settings('phase_template') (falls back to
 * FALLBACK_PHASE_TEMPLATE if that row is missing) and, for each
 * template row, creates a schedule_phases row AND a linked
 * board_groups row in the same pass — the unification invariant
 * applied at seed time (see app/api/projects/[id]/phases/route.ts's
 * GET doc comment for THE INVARIANT in full). The umbrella-kind
 * template row's span comes from computeUmbrellaSeedSpan() (project
 * start, or today, +4 days — the Site Setup umbrella span fix, Fix
 * Round A item 3); every ordinary phase-kind row gets a short
 * placeholder span starting the day after the umbrella ends.
 *
 * Board cockpit round (migration 029) addition — "phase task
 * templates via app_settings 'phase_task_templates' seeded on phase
 * seed": after creating each phase's board_groups row, this also reads
 * app_settings('phase_task_templates') (keyed by phase NAME, see that
 * migration's PART 2 comment) and, if that phase name has a non-empty
 * checklist, creates one board_tasks row per checklist item —
 * unassigned, no due date (a template task is a title/kind only; staff
 * assign + date them same as any manually-added card), phase_group_id
 * set to the just-created group so they appear immediately in that
 * phase's Grouped-list section. Uses this project's FIRST board_columns
 * entry as every seeded task's column_id (columns are seeded
 * separately and independently by GET /api/projects/[id]/board — see
 * that route's own DEFAULT_COLUMNS_V2 seed — so this function
 * seeds/reuses a minimal "Waiting"-only column set here if none exist
 * yet, purely so a template task has somewhere to live; the full
 * default column set still gets seeded normally the first time the
 * Board is opened, same "seed on first visit" idempotent pattern this
 * whole file already follows for phases/groups). Missing/empty
 * template for a phase name is a no-op for that phase (no fabricated
 * "typical" checklist — same "don't invent data nobody asked for"
 * discipline as lib/calculators.ts).
 */
export async function seedPhaseTemplateIfEmpty(
  // Untyped-generic SupabaseClient — same parameter typing convention
  // as lib/auth.ts's getUserRole()/isAdmin() and
  // lib/client-event-reminders.ts, so this one function serves both
  // the cookie-session client (API routes/Server Components) and a
  // service-role client interchangeably without depending on the exact
  // return type of lib/supabase/server.ts's createClient() (which
  // itself depends on next/headers and cannot be imported into every
  // context that might want this helper).
  supabase: SupabaseClient,
  projectId: string
): Promise<void> {
  const { count } = await supabase
    .from("schedule_phases")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId)
    .is("deleted_at", null);
  if ((count ?? 0) > 0) return;

  const { data: settingsRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "phase_template")
    .maybeSingle();

  const template =
    (settingsRow?.value as { name: string; kind: "phase" | "umbrella" }[] | undefined) ??
    FALLBACK_PHASE_TEMPLATE;
  if (!template.length) return;

  // Board cockpit round — phase task templates (app_settings
  // 'phase_task_templates'). Read once, alongside the phase template
  // itself, so the loop below can look up each phase's checklist by
  // name without a query per phase.
  const { data: taskTemplatesRow } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "phase_task_templates")
    .maybeSingle();
  const taskTemplates = (taskTemplatesRow?.value as PhaseTaskTemplatesMap | undefined) ?? {};

  // A template task needs SOME board_columns row to live in. Columns
  // are normally seeded by GET /api/projects/[id]/board (Waiting-first
  // DEFAULT_COLUMNS_V2) — reuse the first existing one if this project
  // already has columns, otherwise seed a single minimal "Waiting"
  // column here (the full default set still seeds normally the first
  // time the Board itself is opened; this is only a landing spot for
  // template tasks created before that ever happens, e.g. a project
  // whose Timeline is opened first).
  let defaultColumnId: string | null = null;
  if (Object.values(taskTemplates).some((rows) => rows.length > 0)) {
    const { data: existingColumn } = await supabase
      .from("board_columns")
      .select("id")
      .eq("project_id", projectId)
      .order("sort", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (existingColumn) {
      defaultColumnId = existingColumn.id;
    } else {
      const { data: seededColumn } = await supabase
        .from("board_columns")
        .insert({ project_id: projectId, name: "Waiting", sort: 0 })
        .select("id")
        .single();
      defaultColumnId = seededColumn?.id ?? null;
    }
  }

  const umbrellaSpan = computeUmbrellaSeedSpan([]);
  const ordinaryStart = new Date(umbrellaSpan.end_date + "T00:00:00Z");
  ordinaryStart.setUTCDate(ordinaryStart.getUTCDate() + 1);
  const ordinaryStartStr = ordinaryStart.toISOString().slice(0, 10);
  const ordinaryEnd = new Date(ordinaryStart);
  ordinaryEnd.setUTCDate(ordinaryEnd.getUTCDate() + 4);
  const ordinaryEndStr = ordinaryEnd.toISOString().slice(0, 10);

  let sort = 0;
  for (const row of template) {
    const isUmbrella = row.kind === "umbrella";
    const span = isUmbrella ? umbrellaSpan : { start_date: ordinaryStartStr, end_date: ordinaryEndStr };

    const { data: phase, error: phaseError } = await supabase
      .from("schedule_phases")
      .insert({
        project_id: projectId,
        name: row.name,
        start_date: span.start_date,
        end_date: span.end_date,
        color_key: isUmbrella ? "charcoal" : "sand",
        kind: row.kind,
        sort: isUmbrella ? -SORT_STEP : sort * SORT_STEP,
      })
      .select("id")
      .single();

    if (phaseError || !phase) continue; // best-effort — a single row failing (e.g. duplicate concurrent seed) shouldn't abort the rest
    if (!isUmbrella) sort += 1;

    const { data: group } = await supabase
      .from("board_groups")
      .insert({ project_id: projectId, name: row.name, sort: sort * SORT_STEP, phase_id: phase.id })
      .select("id")
      .single();

    // Board cockpit round — seed this phase's task checklist, if the
    // template has one AND a column exists to put them in. Best-effort
    // per row, same "one failing row doesn't abort the rest" discipline
    // as the phase insert above.
    const checklist = taskTemplates[row.name];
    if (group && defaultColumnId && checklist && checklist.length > 0) {
      const taskRows = checklist.map((item, i) => ({
        project_id: projectId,
        column_id: defaultColumnId,
        phase_group_id: group.id,
        title: item.title,
        kind: item.kind,
        sort: i * TASK_SORT_STEP,
        created_by: null,
      }));
      await supabase.from("board_tasks").insert(taskRows);
    }
  }
}
