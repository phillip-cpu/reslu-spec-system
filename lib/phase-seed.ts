import type { SupabaseClient } from "@supabase/supabase-js";
import { computeUmbrellaSeedSpan, FALLBACK_PHASE_TEMPLATE } from "@/lib/phase-template";

const SORT_STEP = 1000;

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

    await supabase
      .from("board_groups")
      .insert({ project_id: projectId, name: row.name, sort: sort * SORT_STEP, phase_id: phase.id });
  }
}
