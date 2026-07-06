// ============================================================
// RESLU Spec System — Design task templates (7 July 2026, "Two from
// Phillip" item 2): "Design board tasks pre-populated from the Monday
// template" — app_settings key 'design_task_templates', mirroring
// lib/phase-template.ts's FALLBACK_PHASE_TEMPLATE code-level-fallback
// mechanism exactly (see that file's own doc comment): this constant
// is the fallback used by GET /api/settings/design-task-templates and
// the design-phase seed path (app/api/projects/[id]/design/route.ts)
// whenever the app_settings('design_task_templates') row is absent —
// no new migration seeds this row (this round's explicit "no schema"
// boundary; migration 029 seeded 'phase_task_templates' via SQL, but
// this round does the equivalent entirely in code instead, which the
// task brief calls out as "acceptable and preferred here").
//
// SEED CONTENT PROVENANCE: every title below is extracted, verbatim or
// lightly reworded into an actionable task title, from
// docs/DESIGN-FRAMEWORK-BRIEF.md's "What Currently Happens at Each
// Phase" section (the per-phase prose describing the real Monday board
// template, board ID 5027297754) — NOT invented. Two phases needed
// light judgement calls, both noted inline below:
//   - "Concepts" has no bulleted item list in the brief, only prose
//     ("Pinterest direction, 3D concept model, materials board") — the
//     three deliverables named in that prose are used as the three
//     task titles.
//   - "Sampling & Furniture" is this app's own single combined phase
//     (types/phase-12b.ts's DESIGN_PHASE_TEMPLATE, per BUILD-SPEC.md —
//     see that file's doc comment) mapping onto the brief's TWO
//     separate Monday groups, "Sampling" and "Furniture", both of which
//     the brief explicitly says are "currently empty in the template" —
//     so this one phase is seeded with NO tasks (empty array), same
//     "don't invent data nobody asked for" discipline
//     lib/phase-seed.ts's own doc comment already states for
//     'phase_task_templates'.
//
// These are EDITABLE STARTING POINTS, not a fixed/authoritative
// checklist — Settings > "Design task templates" (mirrors
// PhaseTaskTemplateSettings.tsx) lets Tenille/Phillip add, reorder, or
// delete any of these per phase at any time; editing there never
// touches an already-seeded project, same "only affects future seeds"
// model as every other template editor in this app.
// ============================================================

import { DESIGN_PHASE_TEMPLATE } from "@/types/phase-12b";
import type { DesignTaskTemplatesMap } from "@/types/round-c";

/**
 * The code-level fallback default — analogous to
 * lib/phase-template.ts's FALLBACK_PHASE_TEMPLATE, but for
 * 'design_task_templates' instead of 'phase_template'. Keyed by the
 * exact 7 phase names in types/phase-12b.ts's DESIGN_PHASE_TEMPLATE
 * (Project Milestones / Presentation / Concepts / 3D Working Model /
 * WD Package / Renders / Sampling & Furniture) — see this file's header
 * comment for where each title came from.
 */
export const FALLBACK_DESIGN_TASK_TEMPLATES: DesignTaskTemplatesMap = {
  "Project Milestones": [
    { title: "Initial Consult & Concept Development" },
    { title: "Design Fee Proposal" },
    { title: "Design Development Presentation" },
    { title: "Working Drawings for Approval" },
    { title: "Final WD Design Revision" },
    { title: "Construction Scope Of Works" },
  ],
  Presentation: [
    { title: "Concept Meeting" },
    { title: "Design Development Meeting" },
    { title: "Working Drawing Presentation" },
    { title: "Final Client Review Meeting" },
  ],
  // No bulleted item list in the brief for this phase — the three
  // deliverables named in its prose ("Pinterest direction, 3D concept
  // model, materials board") used as titles. See file header comment.
  Concepts: [
    { title: "Pinterest / mood board direction" },
    { title: "3D concept model" },
    { title: "Materials board" },
  ],
  "3D Working Model": [
    { title: "Base Model" },
    { title: "Joinery" },
    { title: "Windows & Doors" },
    { title: "External Works" },
    { title: "Appliances" },
    { title: "Bathroom" },
    { title: "Ensuite" },
    { title: "Powder Room" },
    { title: "Site Measure" },
  ],
  "WD Package": [
    { title: "Site & Location Plans" },
    { title: "Demolition Plan" },
    { title: "Proposed Plan" },
    { title: "RCP" },
    { title: "Electrical Plan" },
    { title: "Window & Door Schedule" },
    { title: "Internal Glazing Elevations" },
    { title: "Stone Cutout Plans" },
    { title: "Internal Elevations" },
    { title: "Wet Area Detail Plans & Elevations" },
  ],
  Renders: [
    { title: "Bedroom render" },
    { title: "Kitchen render" },
    { title: "Bathroom render" },
  ],
  // Brief: both source Monday groups ("Sampling", "Furniture") are
  // "currently empty in the template" — seeded empty, not invented.
  "Sampling & Furniture": [],
};

// Defensive invariant check (dev-time only signal, not a runtime
// guard): every DESIGN_PHASE_TEMPLATE name should have an entry here,
// even if empty, so a phase never silently has "undefined" template
// behaviour vs. "deliberately empty" — kept as a plain exported
// constant rather than a thrown assertion, since this file must stay
// side-effect-free (imported by both a Server Component and API
// routes).
export const _ALL_PHASES_COVERED = DESIGN_PHASE_TEMPLATE.every(
  (name) => FALLBACK_DESIGN_TASK_TEMPLATES[name] !== undefined
);
