// ============================================================
// RESLU Spec System — Phase unification: shared seed template + the
// unification invariant's pure helpers (Fix Round A).
// Pure, dependency-free domain logic — no Supabase/Next imports —
// mirroring lib/leads.ts / lib/trade-visits.ts / lib/insurance.ts's
// exact shape, so the SAME seed math and matching rules are used
// whether the seed is triggered from the Timeline tab or the Board's
// Grouped-list view (BUILD-SPEC.md "Pre-populated phases": "phase
// template seeded on first Timeline OR Board-grouped visit (shared
// seed path)").
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

/** One row of the editable phase_template (app_settings key 'phase_template', migration 023). */
export interface PhaseTemplateRow {
  name: string;
  kind: "phase" | "umbrella";
}

/** The migration-seeded default — kept here too as the fallback if app_settings has somehow lost the row (defensive; the migration seeds it unconditionally, so this should never actually trigger in practice). Intentionally IDENTICAL to migration 023's seed literal — if you change one, change both. */
export const FALLBACK_PHASE_TEMPLATE: PhaseTemplateRow[] = [
  { name: "Site Setup", kind: "umbrella" },
  { name: "Demolition", kind: "phase" },
  { name: "Rough-in", kind: "phase" },
  { name: "Waterproofing & Tiling", kind: "phase" },
  { name: "Fit-off", kind: "phase" },
  { name: "Handover", kind: "phase" },
];

/** Marker prefix written into schedule_phases.notes for phases created by the migration 023 board-group backfill with no real dates yet (see that migration's data-migration block) — the Timeline UI (GanttChart.tsx) checks notes?.startsWith(this) to render a "needs dates" flag rather than parsing free text elsewhere. */
export const PHASE_NEEDS_DATES_NOTE_PREFIX = "[unification: needs dates]";

export function phaseNeedsDatesFlag(notes: string | null): boolean {
  return !!notes && notes.startsWith(PHASE_NEEDS_DATES_NOTE_PREFIX);
}

function toDateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Site Setup umbrella span fix (BUILD-SPEC.md "Site Setup umbrella
 * span" item 3): "editable start/end like a normal phase, default =
 * project start + ~3-5 days" — this task's brief pins it to exactly
 * "project's earliest phase start (or today) + 4 days".
 *
 * REPLACES the old auto-span-whole-project behaviour entirely (that
 * logic lived in app/api/projects/[id]/phases/route.ts's GET handler,
 * recomputing the umbrella's start/end to min/max of every ordinary
 * phase on every single read — removed in this task; see that route's
 * updated doc comment). This function is called EXACTLY ONCE, at seed
 * time (when a project's phase template is first applied and no
 * umbrella row exists yet) — after that, the umbrella's dates are
 * ordinary, user-editable data like any other phase's, per
 * PATCH /api/phases/[id] (also updated in this task to stop blocking
 * name/start_date/end_date edits on umbrella-kind rows).
 */
export function computeUmbrellaSeedSpan(
  existingPhaseStartDates: string[],
  now: Date = new Date()
): { start_date: string; end_date: string } {
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let earliest = today;
  for (const s of existingPhaseStartDates) {
    const d = new Date(s + "T00:00:00Z");
    if (d.getTime() < earliest.getTime()) earliest = d;
  }
  const end = new Date(earliest.getTime() + 4 * DAY_MS);
  return { start_date: toDateOnly(earliest), end_date: toDateOnly(end) };
}

/**
 * Phase <-> board-group name matching rule — the SAME case-insensitive,
 * trimmed comparison migration 023's one-time data backfill used, kept
 * here as a named, testable, reusable function so the ongoing
 * "creating a phase creates/links its board group and vice versa"
 * invariant (see app/api/projects/[id]/phases/route.ts POST and
 * app/api/projects/[id]/board/groups/route.ts POST, both updated in
 * this task) uses the identical rule the migration used, rather than
 * two hand-written comparisons silently drifting apart over time.
 */
export function namesMatch(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
