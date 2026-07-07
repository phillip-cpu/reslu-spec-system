// ============================================================
// RESLU Spec System — SOW clause template library
// BUILD-SPEC.md "SOW completion + Aria plan analysis": "Clause
// library: extract standard content from the two CURRENT reference
// SOWs (docs/sow-source-goldsworthy-v42.txt, docs/sow-source-alley-v6.txt
// — Phillip confirmed latest): General Notes boilerplate (Site
// Conditions & Protection / Compliance incl. NCC + AS 3740 + SA
// variations wording / Drawings & Specifications precedence clause),
// Site Management & Handover, standard Exclusions, room-section
// patterns, Project Overview skeleton (RESLU positioning paragraph).
// Seed as sow templates so a new SOW starts pre-populated; all
// editable per project."
//
// Pure TS constants — no new table, no migration. "Start from
// template" (POST /api/projects/[id]/sow/[sowId]/from-template) copies
// these into ordinary sow_sections/sow_lines rows, indistinguishable
// from hand-typed content afterwards — the whole point per the build
// spec ("all editable per project"). Content below is lifted near-
// verbatim from the two reference documents (docs/sow-source-
// goldsworthy-v42.txt, docs/sow-source-alley-v6.txt), trimmed of
// project-specific detail (addresses, product codes, client names)
// and generalised into re-usable clauses. Placeholders use
// {{double-brace}} tokens the team fills in by editing the line, same
// as any other SOW line — no template-engine substitution happens
// server-side.
//
// Dependency-free (no Supabase/Next imports), same convention as
// lib/estimate.ts / lib/sow.ts.
// ============================================================

import type { LocalSowLineKind, SowTemplateSection } from "@/types/phase-12a-a";

function inc(text: string): { text: string; kind: LocalSowLineKind } {
  return { text, kind: "inclusion" };
}
function note(text: string): { text: string; kind: LocalSowLineKind } {
  return { text, kind: "note" };
}
function exc(text: string): { text: string; kind: LocalSowLineKind } {
  return { text, kind: "exclusion" };
}

// ------------------------------------------------------------
// 1. Project Overview skeleton
// Lifted from both sources' near-identical opening paragraphs
// (Goldsworthy v42 §1, Alley v6 §1) — the RESLU positioning paragraph
// is word-for-word identical across both, so it's extracted as the
// fixed clause; the scope-specific first paragraph is a fill-in
// {{scope summary}} line the team writes per project.
// ------------------------------------------------------------
export const PROJECT_OVERVIEW: SowTemplateSection = {
  heading: "Project Overview",
  lines: [
    note(
      "This scope covers {{scope summary — e.g. \"the wet area renovation at\"}} {{project address}}, as designed and managed by RESLU."
    ),
    note(
      "RESLU is a design-led building practice. Our work is defined by considered material selection, precise detailing, and rigorous coordination between design intent and on-site delivery."
    ),
    note(
      "{{scope description — list the rooms/works covered, e.g. \"The scope includes full demolition and rebuild of the main bathroom and ensuite...\"}}"
    ),
    note(
      "All works to be carried out in accordance with RESLU's documentation, the NCC (National Construction Code), relevant Australian Standards, and all applicable South Australian regulations."
    ),
    note(
      "This document is organised by room. Each section covers all works applicable to that space, allowing room-by-room review of the complete scope."
    ),
  ],
};

// ------------------------------------------------------------
// 2. General Notes — three subgroups per BUILD-SPEC.md, each rendered
// as its own section (the sow_sections/sow_lines schema is flat —
// heading + lines — so "subgrouped" is expressed as three consecutive
// sections rather than a nested structure, matching how the reference
// SOWs actually render subheadings within "2. General Notes" on the
// page).
// ------------------------------------------------------------

/** Site Conditions & Protection — Goldsworthy v42 §2 + Alley v6 §2 (Site Protection & Preparation), merged. */
export const GENERAL_NOTES_SITE_CONDITIONS: SowTemplateSection = {
  heading: "General Notes — Site Conditions & Protection",
  lines: [
    inc("Ram board protection to all retained floor surfaces prior to commencement of works."),
    inc(
      "External floor protection (where applicable): OSB timber sheeting to all external pavers, terraces, steps, and building entry points. Sheets to be secured and maintained."
    ),
    inc("Supply and remove skip bins for all demolition waste. All demolished materials to be disposed of off-site."),
    inc("Restore any damage to remaining structure caused by failure to adequately protect retained elements."),
    inc("All retained finishes, joinery, fittings, fixtures, and glazing to be protected throughout construction."),
    note(
      "{{list retained items to protect, e.g. skirting boards, cornices, switch plates, GPO face plates, mechanical grilles}} to be retained and protected throughout."
    ),
    note("Slab scan required prior to any penetrations through slab, where applicable."),
    note("All sub-contractors to attend site induction prior to commencement of works."),
    note("Building access to be coordinated with building manager / body corporate throughout, where applicable."),
  ],
};

/** Compliance — Goldsworthy v42 §2 + Alley v6 §14, incl. AS 3740-2010 + BCA + SA variation wording per the build spec. */
export const GENERAL_NOTES_COMPLIANCE: SowTemplateSection = {
  heading: "General Notes — Compliance",
  lines: [
    inc("All works to comply with the NCC, all relevant Australian Standards, and applicable South Australian regulations."),
    inc("Waterproofing to all wet areas per AS 3740-2010, BCA Part 3.8.1, and BCA SA Variation 3.8.1.2."),
    inc("Mechanical ventilation to BCA Part 3.8.7.3 — all exhaust fans vented to atmosphere."),
    note("Prepare and provide all compliance documentation, including waterproofing inspection reports, certificates of compliance, and relevant warranties."),
  ],
};

/** Drawings & Specifications precedence clause — Goldsworthy v42 §2, verbatim structure with placeholders for the project's own drawing set + FF&E schedule filenames. */
export const GENERAL_NOTES_DRAWINGS: SowTemplateSection = {
  heading: "General Notes — Drawings & Specifications",
  lines: [
    note(
      "This Scope of Works is to be read in conjunction with the current working drawings ({{drawing set filename}}) and the RESLU FF&E and Finishes Schedule ({{FF&E schedule filename}}). Product codes referenced throughout this document correspond to the FF&E and Finishes Schedule. In the event of conflict between documents, the drawings take precedence unless otherwise noted."
    ),
    note("All dimensions to be verified on site prior to manufacture, ordering, or installation. Any discrepancies to be raised with RESLU immediately."),
  ],
};

// ------------------------------------------------------------
// 3. Site Management & Handover — Goldsworthy v42 §7 + Alley v6 §14
// (During Construction / Handover), merged into one standard section.
// ------------------------------------------------------------
export const SITE_MANAGEMENT_HANDOVER: SowTemplateSection = {
  heading: "Site Management & Handover",
  lines: [
    inc("Professional construction & detail clean prior to handover."),
    inc("Make good all surfaces affected by demolition or service modifications."),
    inc("All hardware to be adjusted, tested, and functioning prior to handover."),
    inc("All penetrations through fire-rated elements to be reinstated with appropriate fire stop system, where applicable."),
    inc("Touch up all paint and finishes on completion."),
    inc("Provide all product warranties, maintenance guides, and certificates of compliance to RESLU on completion."),
    inc("Remove all protective coverings, tape, and temporary fixings. Leave site clean and ready for photography."),
  ],
};

// ------------------------------------------------------------
// 4. Standard Exclusions — Goldsworthy v42 §8 + Alley v6 §15, merged
// (Alley's extra two lines re client-supplied items / TBC items kept
// as optional-flavoured notes the team deletes if not relevant).
// ------------------------------------------------------------
export const EXCLUSIONS: SowTemplateSection = {
  heading: "Exclusions",
  lines: [
    exc("Structural engineering (to be confirmed if required)."),
    exc("External works."),
    exc("Development approval (client to arrange if required)."),
    exc("Loose furniture, artwork, and decorative items not noted in the FF&E agreement."),
    exc("Staging and styling."),
    exc("Items marked TBC — subject to further documentation."),
    exc("Client-supplied items — procurement by client; installation and connections included where noted in the relevant room section."),
    exc("Any works to areas not documented or outlined in this scope of works. Any discrepancies are to be brought to the attention of RESLU as soon as possible."),
  ],
};

// ------------------------------------------------------------
// 5. Room-section pattern — the recurring sub-heading skeleton every
// wet-area/room section in both sources follows (Demolition ->
// Partitions & Plastering -> Electrical & Lighting -> Waterproofing ->
// Floor Finishes -> Wall Tiling -> Joinery -> Stone -> Sanitaryware &
// Tapware -> Shower Screen -> Painting -> Specialty Items). Applied
// per room when "Start from template" creates one section per project
// room — the team deletes whichever sub-groups don't apply to that
// room (e.g. a bedroom section keeps only Demolition/Joinery/Painting).
// ------------------------------------------------------------
export function roomSectionTemplate(roomName: string): SowTemplateSection {
  return {
    heading: roomName,
    lines: [
      note(`Ref: {{drawing references for ${roomName}}}`),
      inc("DEMOLISH — full strip-out as shown by hatch on plan. Remove and dispose off-site. {{scope specifics}}"),
      note("PARTITIONS & PLASTERING — {{new stud walls / MR plasterboard to wet areas / make good ceiling at service penetrations, as applicable}}."),
      // Added per Phillip 7 Jul — screed/subfloor was missing from the
      // extracted pattern. Sequencing vs membrane left as a template
      // variable: RESLU's issued SOW wording says "waterproofing ...
      // completed prior to tile bed" while Phillip described bed-first —
      // both assemblies exist; the editable placeholder forces a per-job
      // decision instead of hard-coding one.
      note("SUBFLOOR — {{screed bed to falls to waste / levelling compound as required; sequencing relative to membrane per waterproofing system specification}}."),
      note("ELECTRICAL & LIGHTING — {{downlights, wall lights, exhaust fan, GPOs per FF&E schedule item codes}}."),
      note("WATERPROOFING — full floor waterproofing including 200mm minimum upturn to all walls; full-height waterproofing to all shower walls. Waterproofing by tiling contractor, completed prior to tile bed. An independent third-party inspector to be engaged by RESLU to inspect and certify waterproofing compliance prior to tiling."),
      note("FLOOR FINISHES — {{tile/floor product code per FF&E schedule}}."),
      note("WALL TILING — {{tile product code(s) per FF&E schedule; grout colour and joint width confirmed by designer prior to commencement}}."),
      note("JOINERY — {{joinery code, joiner to supply/install, dimensions verified on site prior to manufacture}}."),
      note("STONE — {{stone code, benchtop profile, templated on site after joinery is set}}."),
      note("SANITARYWARE & TAPWARE — {{product codes per FF&E schedule}}. Cap back all redundant supply and waste lines. No dead legs."),
      note("SHOWER SCREEN — {{screen code, glass spec, hardware finish}}. Per AS/NZS 2208."),
      note(
        "PAINTING — all new plasterboard surfaces to be set, sanded, and primed prior to painting. 3-step system to all new plasterboard: (1) full sealer/primer coat, (2) first finish coat, (3) second finish coat, each fully dry before the next is applied. Colours to be tested on site prior to commencement — painter to provide sample patches for RESLU sign-off before full application. Caulk all junctions prior to painting."
      ),
      note("SPECIALTY ITEMS — {{mirrors, robe hooks, towel rails, etc. per FF&E schedule}}."),
    ],
  };
}

// ------------------------------------------------------------
// Named library — the groups "Start from template" can apply. Keys
// are the `groups` values ApplyTemplateInput.groups accepts.
// ------------------------------------------------------------
export const SOW_TEMPLATE_LIBRARY: Record<string, SowTemplateSection> = {
  project_overview: PROJECT_OVERVIEW,
  general_notes_site_conditions: GENERAL_NOTES_SITE_CONDITIONS,
  general_notes_compliance: GENERAL_NOTES_COMPLIANCE,
  general_notes_drawings: GENERAL_NOTES_DRAWINGS,
  site_management_handover: SITE_MANAGEMENT_HANDOVER,
  exclusions: EXCLUSIONS,
};

/** The standard, full group order applied when no `groups` filter is given — everything except room sections (added separately, one per project room). */
export const STANDARD_TEMPLATE_GROUPS = [
  "project_overview",
  "general_notes_site_conditions",
  "general_notes_compliance",
  "general_notes_drawings",
] as const;

/** Trailing groups, applied after room sections. */
export const TRAILING_TEMPLATE_GROUPS = ["site_management_handover", "exclusions"] as const;
