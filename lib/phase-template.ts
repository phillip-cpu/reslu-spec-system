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

/**
 * One row of a phase's editable task checklist (app_settings key
 * 'phase_task_templates', migration 029 PART 2) — deliberately the
 * same { title, kind } shape as types/board-cockpit.ts's
 * PhaseTaskTemplateRow (not imported from there — this file stays
 * dependency-free/pure per its own header comment, so the shape is
 * duplicated rather than cross-imported; both are kept structurally
 * identical on purpose).
 */
export interface PhaseTaskTemplateSeedRow {
  title: string;
  kind: "task" | "milestone";
}

/**
 * Board v3 — Monday parity round: REPLACES the prior 6-phase
 * (Site Setup umbrella / Demolition / Rough-in / Waterproofing &
 * Tiling / Fit-off / Handover) code-level fallback with the real
 * 13-stage construction template (BUILD-SPEC.md "Board v3 — Monday
 * parity" §1, "the real 13-stage template"), used both as the
 * DEFAULT for brand-new projects AND as this file's own defensive
 * fallback if app_settings('phase_template') has somehow lost its row
 * (the migration seeds it unconditionally, so this should never
 * actually trigger in practice — same defensive-only framing as
 * before this round).
 *
 * None of these 13 rows are kind='umbrella' — the spec's stage list
 * describes 13 ordinary sequential stages with no umbrella/banner
 * phase, unlike the old 6-phase list's "Site Setup" umbrella. This is
 * a deliberate, safe change: every umbrella consumer in this codebase
 * (components/gantt/GanttChart.tsx's `phases.find(p => p.kind ===
 * "umbrella") ?? null`, app/api/projects/[id]/phases/route.ts, this
 * app's Timeline page) already treats "no umbrella phase" as a valid,
 * null-safe state — a project seeded from this template simply shows
 * no umbrella band on the Timeline, the same as it would for any
 * project whose team deleted their umbrella phase today. The
 * PUT /api/settings/phase-template admin editor's "exactly one
 * umbrella row" validation only applies to an ADMIN EDIT of the
 * template through that route — it does not re-validate this
 * code-level fallback constant, so shipping a fallback with zero
 * umbrella rows is not blocked by that check.
 *
 * Every stage ends with its own milestone item (the literal
 * "◆ Stage complete – {stage outcome}" line) except Stage 13
 * (Handover & Close Out), which is the final stage and, per spec, ends
 * with a plain item ("Project archived") instead — see
 * FALLBACK_PHASE_TASK_TEMPLATES below for the per-stage task
 * checklists (including these milestone rows), and
 * lib/board-constants.ts's STAGE_PALETTE for the rotating 5-colour
 * left-bar/title treatment cycling by these rows' sort order.
 */
export const FALLBACK_PHASE_TEMPLATE: PhaseTemplateRow[] = [
  { name: "Stage 1 – Site Establishment", kind: "phase" },
  { name: "Stage 2 – Demolition & Strip Out", kind: "phase" },
  { name: "Stage 3 – Structural & Framing", kind: "phase" },
  { name: "Stage 4 – External Envelope", kind: "phase" },
  { name: "Stage 5 – Service Rough In", kind: "phase" },
  { name: "Stage 6 – Internal Linings", kind: "phase" },
  { name: "Stage 7 – Internal Finishes", kind: "phase" },
  { name: "Stage 8 – Joinery & Fixed Elements", kind: "phase" },
  { name: "Stage 9 – Fit Off", kind: "phase" },
  { name: "Stage 10 – Painting & Final Detail", kind: "phase" },
  { name: "Stage 11 – External Works", kind: "phase" },
  { name: "Stage 12 – Practical Completion", kind: "phase" },
  { name: "Stage 13 – Handover & Close Out", kind: "phase" },
];

/**
 * Board v3 — Monday parity round: the code-level fallback for
 * app_settings('phase_task_templates') — this migration (031) adds NO
 * new app_settings seed row of its own (unlike migration 029's
 * one-phase "Site Setup" seed); the full 13-stage checklist ships
 * purely as this code constant, mirroring EXACTLY how
 * lib/design-task-templates.ts's FALLBACK_DESIGN_TASK_TEMPLATES ships
 * its own seed content in code rather than via a migration (see that
 * file's own header comment for the identical rationale: "acceptable
 * and preferred here" over a SQL seed for a large, editable-afterwards
 * checklist). Consumed by lib/phase-seed.ts's
 * seedPhaseTemplateIfEmpty() (falls back to this constant when
 * app_settings('phase_task_templates') has no matching key/is
 * missing), GET /api/settings/phase-task-templates, and the Settings
 * page's server-side read — all three already had a `?? {}` fallback
 * before this round; this constant now takes that place so a brand
 * new environment (migration run, but nobody has ever opened Settings
 * to edit this key) still seeds the full Monday-parity checklist, not
 * an empty one.
 *
 * Every stage's list ends with its own milestone row (kind:
 * "milestone") reading "◆ Stage complete – {outcome}" verbatim from
 * BUILD-SPEC.md, EXCEPT Stage 13 (Handover & Close Out), whose final
 * row ("Project archived") is a plain kind: "task" row — Stage 13 is
 * the last stage in the sequence and per spec has no "stage complete"
 * milestone of its own to hand off to a next stage.
 */
export const FALLBACK_PHASE_TASK_TEMPLATES: Record<string, PhaseTaskTemplateSeedRow[]> = {
  "Stage 1 – Site Establishment": [
    { title: "Site fencing installed", kind: "task" },
    { title: "Site amenities installed", kind: "task" },
    { title: "Protection to existing surfaces", kind: "task" },
    { title: "Temporary services installed", kind: "task" },
    { title: "Site sign installed", kind: "task" },
    { title: "Site camera installed", kind: "task" },
    { title: "Waste removal & bin management", kind: "task" },
    { title: "Stage complete – Site ready", kind: "milestone" },
  ],
  "Stage 2 – Demolition & Strip Out": [
    { title: "Internal demolition", kind: "task" },
    { title: "External demolition", kind: "task" },
    { title: "Bin management", kind: "task" },
    { title: "Make good works, tarping, boarding", kind: "task" },
    { title: "Structural exposure complete", kind: "task" },
    { title: "Stage complete – Demolition complete", kind: "milestone" },
  ],
  "Stage 3 – Structural & Framing": [
    { title: "Footings & slabs", kind: "task" },
    { title: "Structural steel installation", kind: "task" },
    { title: "Wall framing", kind: "task" },
    { title: "Roof framing", kind: "task" },
    { title: "Engineering inspection & sign off", kind: "task" },
    { title: "Stage complete – Frame approved", kind: "milestone" },
  ],
  "Stage 4 – External Envelope": [
    { title: "Roof flashings & sarking", kind: "task" },
    { title: "Roofing installation", kind: "task" },
    { title: "External windows & doors", kind: "task" },
    { title: "Brickwork", kind: "task" },
    { title: "External cladding", kind: "task" },
    { title: "External waterproofing", kind: "task" },
    { title: "Stage complete – Build sealed", kind: "milestone" },
  ],
  "Stage 5 – Service Rough In": [
    { title: "Electrical rough in", kind: "task" },
    { title: "Plumbing rough in", kind: "task" },
    { title: "HVAC rough in", kind: "task" },
    { title: "Data & security rough in", kind: "task" },
    { title: "In-wall inspections completed", kind: "task" },
    { title: "Stage complete – Services rough in complete", kind: "milestone" },
  ],
  "Stage 6 – Internal Linings": [
    { title: "Insulation installed", kind: "task" },
    { title: "Plasterboard walls & ceilings", kind: "task" },
    { title: "Set & sand", kind: "task" },
    // Screed beds MUST precede waterproofing (falls to waste formed in
    // the bed, membrane goes over it) — was missing from the Monday
    // template; added per Phillip 7 Jul.
    { title: "Wet area subfloor prep & screed beds (falls to waste)", kind: "task" },
    { title: "Internal waterproofing to wet areas", kind: "task" },
    { title: "Stage complete – Linings complete", kind: "milestone" },
  ],
  "Stage 7 – Internal Finishes": [
    { title: "Tiling by area", kind: "task" },
    { title: "Flooring installation", kind: "task" },
    { title: "Feature finishes & architectural coatings", kind: "task" },
    { title: "Stage complete – Internal finishes complete", kind: "milestone" },
  ],
  "Stage 8 – Joinery & Fixed Elements": [
    { title: "Kitchen joinery installation", kind: "task" },
    { title: "Bathroom vanities installation", kind: "task" },
    { title: "Wardrobes", kind: "task" },
    { title: "Fixed feature elements", kind: "task" },
    { title: "Stage complete – Joinery complete", kind: "milestone" },
  ],
  "Stage 9 – Fit Off": [
    { title: "Electrical fit off", kind: "task" },
    { title: "Plumbing fit off", kind: "task" },
    { title: "Appliances installed", kind: "task" },
    { title: "Hardware installation", kind: "task" },
    { title: "Stage complete – Fit off complete", kind: "milestone" },
  ],
  "Stage 10 – Painting & Final Detail": [
    { title: "Internal door installation", kind: "task" },
    { title: "Skirtings installation", kind: "task" },
    { title: "Architraves installation", kind: "task" },
    { title: "Door hardware installation", kind: "task" },
    { title: "Painting", kind: "task" },
    { title: "Touch ups", kind: "task" },
    { title: "Silicone & sealants", kind: "task" },
    { title: "Detail finishing", kind: "task" },
    { title: "Stage complete – Detailing complete", kind: "milestone" },
  ],
  "Stage 11 – External Works": [
    { title: "Landscaping", kind: "task" },
    { title: "Paving & decking", kind: "task" },
    { title: "Fencing & gates", kind: "task" },
    { title: "Drainage works", kind: "task" },
    { title: "Stage complete – External works complete", kind: "milestone" },
  ],
  "Stage 12 – Practical Completion": [
    { title: "Defects inspection", kind: "task" },
    { title: "Defects rectification", kind: "task" },
    { title: "Final builders clean", kind: "task" },
    { title: "Compliance certificates collected", kind: "task" },
    { title: "Stage complete – Practical completion achieved", kind: "milestone" },
  ],
  "Stage 13 – Handover & Close Out": [
    { title: "Client walkthrough", kind: "task" },
    { title: "Handover documentation issued", kind: "task" },
    { title: "Warranties & manuals provided", kind: "task" },
    { title: "Final account settled", kind: "task" },
    // No milestone row — Stage 13 is the final stage and, per
    // BUILD-SPEC.md, "ends with a plain item" rather than a
    // "◆ Stage complete" milestone (there is no next stage to hand off
    // to).
    { title: "Project archived", kind: "task" },
  ],
};

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
