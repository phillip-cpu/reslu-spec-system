// ============================================================
// RESLU Spec System — Fee proposal templates (r23).
// docs/BUILD-SPEC.md §"Fee proposal phase (r23)" item 2: "Templates:
// three seeds (renovation/new build/multi-phase) built from
// docs/proposal-reference-content.md, stored like sow-templates (lib
// file or seed table — match existing convention). Default terms_md
// from the same doc."
//
// Pure TS constants — no new table, matching lib/sow-templates.ts's own
// "seed as templates so a new document starts pre-populated; all
// editable per proposal" convention exactly (that file's own header
// comment is the precedent this one follows). POST /api/proposals
// copies one of these three ProposalContent objects verbatim into a
// new proposals.content jsonb value — from that point on it is
// ordinary, freely-editable data, indistinguishable from hand-typed
// content, same as a SOW started "from template".
//
// Content below is lifted near-verbatim from docs/proposal-reference-
// content.md ("Source docs: 260506 Neave Design Proposal (multi-phase,
// May 2026), Sim & Navroop Greenwith (new build, Feb 2026), Tamsyn
// Alley Glenelg North (renovation, Nov 2025), Dale Hone Service
// Contract (LawDepot, May 2026)"), per that doc's own "Scope section
// templates" / "Default terms" / "Voice rules" sections. Letter/vision
// fields ship with Neave-style EXAMPLE prose (not lorem, not a bare
// skeleton) as a starting placeholder every proposal's admin edits
// per-client — {{double-brace}} tokens mark the genuinely per-client
// specifics (names/address/rooms), same "no template-engine
// substitution happens server-side" convention lib/sow-templates.ts
// already uses for its own {{...}} placeholders.
//
// Dependency-free (no Supabase/Next imports), same convention as
// lib/sow-templates.ts / lib/estimate.ts.
// ============================================================

import type {
  ProposalContent,
  ProposalExclusions,
  ProposalFeeStage,
  ProposalScopeSection,
  ProposalTemplateKind,
  ProposalTimelineRow,
} from "@/types/proposals";

// ------------------------------------------------------------
// Shared fragments — used verbatim across all three templates per
// docs/proposal-reference-content.md's own "Document structure (Neave
// = canonical)" section, which gives these as FIXED text, not
// per-template variations.
// ------------------------------------------------------------

/** Intro letter closing — docs/proposal-reference-content.md item 3, given verbatim ("closes with the studio ethos"). Never edited per-template; the admin may still edit it per-proposal like any other text field. */
export const STUDIO_ETHOS_CLOSING =
  "We operate as a tight, design led studio. The people you met onsite are the ones who will design, document, and oversee the project from start to finish. Nothing is handed off, and every decision is carried through with continuity and intent.";

/** Voice rules sign-off — docs/proposal-reference-content.md "Voice rules for Aria drafts": "sign-off Phillip Introna, Director, RESLU." */
export const LETTER_SIGN_OFF = "Phillip Introna\nDirector, RESLU";

/** PROJECT TIMELINE's fixed closing caveat — docs/proposal-reference-content.md item 7, given verbatim: "always ends: ...". Appended as the LAST row's duration is never this — it is its own trailing line, rendered separately by the client page/PDF beneath the timeline table (see components/proposal/*, components/pdf/ProposalPdf.tsx). Kept here as a named export so every template (and any future one) references the exact same wording rather than re-typing it. */
export const TIMELINE_COUNCIL_CAVEAT =
  "Council assessment timeframes are subject to authority processing and are outside of our control.";

/** EXCLUSIONS & ADDITIONAL CONSULTANT SERVICES bullets — docs/proposal-reference-content.md item 8, shared across all three templates (the doc gives ONE bullet list for the whole document structure, not per-template variants). */
const EXCLUSIONS_BULLETS: string[] = [
  "Structural engineering.",
  "Certifier fees.",
  "Council application and lodgement fees.",
  "Energy assessment.",
  "Soil testing and geotechnical investigation.",
  "Specialist consultants (e.g. acoustic, traffic, arborist) where required.",
  "Construction Training Levy.",
  "Furniture procurement — available as a separate engagement.",
];

function exclusionsBlock(allowanceRange: string): ProposalExclusions {
  return {
    bullets: EXCLUSIONS_BULLETS,
    allowance: `For budgeting purposes, we recommend allowing ${allowanceRange} plus GST for the above external consultants. RESLU coordinates and manages all external consultants as part of the project delivery.`,
  };
}

// ------------------------------------------------------------
// DEFAULT TERMS — docs/proposal-reference-content.md "Default terms
// (from Hone service contract — RESLU custom clauses + core
// boilerplate, editable per proposal)". Rendered as preformatted
// paragraphs (no markdown renderer exists in this repo and this round
// is told not to add one — see app/proposal/[token]/page.tsx /
// components/proposal/TermsSection.tsx) — plain text, ALL-CAPS section
// headings, blank-line-separated paragraphs, no markdown syntax
// characters that would otherwise render literally as asterisks/hashes.
// ------------------------------------------------------------
export const DEFAULT_TERMS_MD = `PARTIES

Client: {{client full name(s)}}, of {{client address}} ("the Client").
Contractor: RESLU Developments, ABN 50 635 440 578, of 219 Sturt Street, Adelaide SA 5000 ("RESLU").

CURRENCY AND PAYMENT

All amounts in this agreement are in Australian dollars (AUD) and include GST unless stated otherwise. The deposit set out in the Design Fee section is payable upon acceptance of this proposal. The remaining fee is invoiced per the Payment Structure set out above. Invoices are due for payment within 7 days of issue. Interest of 25% per annum (or the maximum lawful rate, if lower) applies to amounts overdue.

TRAVEL AND REIMBURSEMENT

Travel expenses incurred outside the agreed scope of this proposal are reimbursed by the Client at cost, on presentation of receipts.

CONFIDENTIALITY

Each party agrees to keep confidential all non-public information received from the other party in connection with this engagement. This obligation survives termination of this agreement.

INTELLECTUAL PROPERTY

All intellectual property developed by RESLU in the course of this engagement — drawings, specifications, designs, and documentation — remains the property of RESLU. The Client is granted a non-exclusive, limited-use licence to use this material for the purpose of constructing and maintaining the project described in this proposal.

INDEPENDENT CONTRACTOR

RESLU performs this engagement as an independent contractor, not as an employee or agent of the Client.

SUBSTITUTION AND SUBCONTRACTORS

RESLU may engage subcontractors or substitute personnel to perform any part of this engagement, provided the standard of work and continuity of design intent set out in this proposal is maintained.

AUTONOMY AND NON-EXCLUSIVITY

Nothing in this agreement restricts RESLU from providing services to other clients during or after this engagement.

NOTICES

Notices under this agreement must be given in writing, by email or post, to the addresses set out above.

MUTUAL INDEMNIFICATION

Each party indemnifies the other against loss or damage arising from that party's own negligent act or omission in connection with this agreement.

MODIFICATION

This agreement may only be modified in writing, signed by both parties.

TIME OF THE ESSENCE

Time is of the essence in respect of all dates and periods set out in this proposal, subject to the Project Timeline's own council-assessment caveat.

ASSIGNMENT

Neither party may assign its rights or obligations under this agreement without the prior written consent of the other party.

ENTIRE AGREEMENT

This proposal, once accepted, constitutes the entire agreement between the parties and supersedes all prior discussions and understandings on the same subject matter.

SEVERABILITY

If any provision of this agreement is found unenforceable, the remaining provisions continue in full force and effect.

WAIVER

A failure by either party to enforce any provision of this agreement is not a waiver of that provision.

GOVERNING LAW

This agreement is governed by the laws of South Australia.

MEDIA AND CONTENT USAGE

The design and construction process may be documented and published on RESLU's social media, website, and marketing materials. RESLU retains creative control and ownership of this content. No personally identifying details of the Client are published without the Client's prior written consent.

VALUE MANAGEMENT AND COST ALIGNMENT

If pricing exceeds the Client's intended budget once documentation is complete, a Value Management (VM) engagement is available to realign scope and cost. Any resulting revisions are treated as a variation to this proposal at RESLU's standard rates, and may influence the project's final outcome, finish, or functionality.

ADDITIONAL SERVICES

Work outside the scope described in this proposal is treated as a variation, charged at $120.00 per hour inc GST, unless otherwise agreed with the Client in writing. RESLU will notify the Client before undertaking additional work where practicable.

NOTE: this legal wording is drafted from RESLU's existing signed service contract template. Phillip should have a solicitor review this merged proposal-and-terms template once before it is relied on as a binding contract.`;

// ------------------------------------------------------------
// PROJECT VISION ALIGNMENT + intro letter — Neave-style example prose,
// shared skeleton, per-template opening line swapped for the relevant
// project type (docs/proposal-reference-content.md's own "Voice rules
// for Aria drafts": "Warm, direct, confident; references the actual
// visit and specific rooms/aspects; 'quiet luxury', restraint/ambition
// balance; never salesy; no em dashes; middots ok").
// ------------------------------------------------------------

function letterFor(openingLine: string): string {
  return `Dear {{client names}},

Thank you for having us out to {{residence address}}. It was a pleasure walking the site with you and hearing how you want to live in the home ahead — {{note something specific from the visit, e.g. the light in the main living space, the way the block falls to the rear garden}}.

${openingLine}

This proposal sets out the design services we'd deliver, the phase structure we'd work through together, and the fee for each stage. It's written to be read alongside the attached terms · once accepted, together they form our agreement.

${STUDIO_ETHOS_CLOSING}

We're looking forward to getting started.

${LETTER_SIGN_OFF}`;
}

function visionFor(body: string): string {
  return `{{residence name / address}} has real bones to work with. ${body}

Our approach favours restraint over spectacle · quiet, considered moves that read as inevitable once built, rather than a house that shouts for attention. Materials are chosen for how they age, not just how they photograph on day one. Every decision — from the plan itself down to a door handle — is carried through with the same intent.

The result is a home that feels distinctly yours: calm, well-made, and built to be lived in for a long time.`;
}

// ------------------------------------------------------------
// 1. RENOVATION — Alley, Glenelg North. Scope sections + fee stages
// per docs/proposal-reference-content.md's "Scope section templates"
// (RENOVATION line) and "DESIGN FEE" (Alley's percentage form: "30%
// deposit on acceptance, 30% Concept presentation, 30% DD+Interior
// Detailing, 10% final Documentation & Quoting").
// ------------------------------------------------------------

const RENOVATION_SCOPE: ProposalScopeSection[] = [
  {
    title: "Masterplan",
    bullets: [
      "Whole-of-home spatial planning to establish the renovation's footprint and priorities.",
      "Preliminary budget estimate to test the scope against your target investment before design proceeds.",
    ],
    deliverables: ["Concept plans", "Mood imagery", "Palette direction"],
  },
  {
    title: "Concept Design",
    bullets: [
      "Development of the masterplan into a resolved three-dimensional form.",
      "Material and finish direction tested against the vision established in the Masterplan stage.",
    ],
    deliverables: ["Photorealistic renders"],
  },
  {
    title: "Design Development — Interior Detailing",
    bullets: [
      "Joinery design and detailing for kitchen, bathrooms, and built-in storage.",
      "Lighting design and furniture layouts for every room in scope.",
      "Curated soft-finish and fixture selections, with supplier specifications.",
    ],
    deliverables: ["Joinery elevations", "Lighting plan", "Finishes and fixtures schedule"],
  },
  {
    title: "Design Development — Construction Detailing",
    bullets: [
      "Resolution of plans and elevations to construction-ready detail.",
      "Coordination with the structural engineer on any changes to the building's structure.",
    ],
    deliverables: ["Resolved plans and elevations", "Engineer coordination notes"],
  },
  {
    title: "Documentation",
    bullets: [
      "Preparation of the full tender and construction documentation set.",
      "Technical specifications to support accurate trade pricing and construction.",
    ],
    deliverables: ["Construction plans", "Joinery documentation", "Finishes schedules", "Technical specifications"],
  },
  {
    title: "Quoting and Scheduling",
    bullets: [
      "RESLU, as builder, prepares trade quotations against the completed documentation.",
      "Development of the construction schedule ahead of site start.",
    ],
    deliverables: ["Itemised quotation", "Construction schedule"],
  },
];

const RENOVATION_FEE_STAGES: ProposalFeeStage[] = [
  {
    label: "Design Fee",
    total_inc: 0,
    milestones: [
      { label: "Deposit on acceptance", amount_inc: 0 },
      { label: "Concept presentation", amount_inc: 0 },
      { label: "Design Development and Interior Detailing", amount_inc: 0 },
      { label: "Final Documentation and Quoting", amount_inc: 0 },
    ],
  },
];

const RENOVATION_TIMELINE: ProposalTimelineRow[] = [
  { phase: "Masterplan and Concept Design", duration: "6 to 8 weeks" },
  { phase: "Design Development and Documentation", duration: "10 to 12 weeks following Concept Design" },
];

// ------------------------------------------------------------
// 2. NEW BUILD — Sim & Navroop, Greenwith. Scope sections + fee stages
// per docs/proposal-reference-content.md's "Scope section templates"
// (NEW BUILD line) and "DESIGN FEE" (Greenwith's percentage form: "30%
// upon engagement, 40% upon completion of Concept Design, 30% prior to
// council lodgement").
// ------------------------------------------------------------

const NEW_BUILD_SCOPE: ProposalScopeSection[] = [
  {
    title: "Site Investigation and Preliminary Coordination",
    bullets: [
      "Coordination of the land survey and identification of slab and site constraints.",
      "Planning assessment against zoning, setback, and building-height controls.",
      "Feasibility review to confirm the brief is achievable on this site.",
    ],
    deliverables: ["Site constraints summary", "Feasibility notes"],
  },
  {
    title: "Concept Design Phase",
    bullets: [
      "Spatial layouts and accommodation planning against your brief.",
      "Ceiling height and volume strategy, and a glazing strategy for light and orientation.",
      "Zoning and circulation planning across the whole home.",
    ],
    deliverables: [
      "Concept floor plans",
      "Preliminary elevations",
      "Preliminary material direction",
      "Design presentation meeting",
    ],
  },
  {
    title: "Design Development",
    bullets: [
      "Refinement of plans, elevations, and sections beyond concept stage.",
      "Material direction resolved to a presentable, buildable palette.",
      "Coordination with planning controls as the design is refined.",
    ],
    deliverables: ["Detailed design presentation package", "3D visuals", "Client review session"],
  },
  {
    title: "Council Documentation and Lodgement",
    bullets: [
      "Preparation of the site plan, floor plans, and elevations for lodgement.",
      "Preparation of supporting planning documentation.",
      "Lodgement with council and management of council correspondence through to determination.",
    ],
    deliverables: ["Lodgement-ready documentation set", "Council correspondence management"],
  },
];

const NEW_BUILD_FEE_STAGES: ProposalFeeStage[] = [
  {
    label: "Design Fee",
    total_inc: 0,
    milestones: [
      { label: "Upon engagement", amount_inc: 0 },
      { label: "Upon completion of Concept Design", amount_inc: 0 },
      { label: "Prior to council lodgement", amount_inc: 0 },
    ],
  },
];

const NEW_BUILD_TIMELINE: ProposalTimelineRow[] = [
  { phase: "Site Investigation and Concept Design", duration: "6 to 8 weeks" },
  { phase: "Design Development and Council Documentation", duration: "10 to 12 weeks following Concept Design" },
];

// ------------------------------------------------------------
// 3. MULTI-PHASE WHOLE-HOME — Neave (canonical). Scope sections + fee
// stages per docs/proposal-reference-content.md's "Scope section
// templates" (MULTI-PHASE line) and "DESIGN FEE" (Neave's dollar form:
// "Stage 1 - $25,927.00 Inc" + Payment Structure milestone lines:
// Engagement / Masterplan, Floor Plan and Design Direction / Design
// Development & Interior Detailing / Documentation / Handover).
// ------------------------------------------------------------

const MULTI_PHASE_SCOPE: ProposalScopeSection[] = [
  {
    title: "Site Investigation and Preliminary Coordination",
    bullets: [
      "Whole-of-home site investigation to establish constraints and opportunities across every phase.",
      "Preliminary coordination to confirm the phase boundaries proposed below.",
    ],
    deliverables: ["Site constraints summary"],
  },
  {
    title: "Phase 1 — Masterplan, Floor Plan and Design Direction",
    bullets: [
      "Whole-of-home spatial planning, establishing the masterplan every later phase works within.",
      "Definition of phase boundaries, so each later stage can be documented and built independently.",
      "A design direction document setting the material and detailing language for the whole home.",
    ],
    deliverables: ["Whole-of-home masterplan", "Design direction document", "Concept presentation"],
  },
  {
    title: "Phase 2 — Detailed Design and Documentation of Priority Zone",
    bullets: [
      "Full wet-area design for the priority zone identified in Phase 1.",
      "Joinery design and shop drawings, and a complete lighting design.",
      "FF&E selection for the priority zone.",
    ],
    deliverables: ["Construction documentation set", "6 photorealistic renders"],
  },
  {
    title: "Phase 3 — Remainder of Home",
    bullets: [
      "Detailed design and documentation of all remaining areas identified in the Phase 1 masterplan.",
      "Preparation of council documentation and management of lodgement.",
      "Liaison with consultants engaged across the remaining scope.",
    ],
    deliverables: ["10 photorealistic renders", "Council documentation prepared and lodged"],
  },
];

const MULTI_PHASE_FEE_STAGES: ProposalFeeStage[] = [
  {
    label: "Stage 1 — Masterplan, Floor Plan and Design Direction",
    total_inc: 0,
    milestones: [
      { label: "Engagement", amount_inc: 0 },
      { label: "Masterplan, Floor Plan and Design Direction", amount_inc: 0 },
      { label: "Design Development and Interior Detailing", amount_inc: 0 },
      { label: "Documentation", amount_inc: 0 },
      { label: "Handover", amount_inc: 0 },
    ],
  },
  {
    label: "Stage 2 — Priority Zone Documentation",
    total_inc: 0,
    milestones: [
      { label: "Engagement", amount_inc: 0 },
      { label: "Design Development and Interior Detailing", amount_inc: 0 },
      { label: "Documentation", amount_inc: 0 },
      { label: "Handover", amount_inc: 0 },
    ],
  },
  {
    label: "Stage 3 — Remainder of Home",
    total_inc: 0,
    milestones: [
      { label: "Engagement", amount_inc: 0 },
      { label: "Design Development and Interior Detailing", amount_inc: 0 },
      { label: "Documentation", amount_inc: 0 },
      { label: "Handover", amount_inc: 0 },
    ],
  },
];

const MULTI_PHASE_TIMELINE: ProposalTimelineRow[] = [
  { phase: "Site Investigation and Phase 1 — Masterplan, Floor Plan and Design Direction", duration: "6 to 8 weeks" },
  { phase: "Phase 2 — Priority Zone Documentation", duration: "10 to 12 weeks following Phase 1" },
  { phase: "Phase 3 — Remainder of Home", duration: "10 to 12 weeks following Phase 2" },
];

// ------------------------------------------------------------
// Public API — one function, three seeds.
// ------------------------------------------------------------

const TEMPLATE_LABELS: Record<ProposalTemplateKind, string> = {
  renovation: "Renovation",
  new_build: "New build",
  multi_phase: "Multi-phase whole-home",
};

export function proposalTemplateLabel(kind: ProposalTemplateKind): string {
  return TEMPLATE_LABELS[kind];
}

/**
 * Returns a fresh ProposalContent seed for the given template kind —
 * called once, by POST /api/proposals, and copied verbatim into the
 * new proposal's content column. Every fee milestone/stage amount
 * ships at 0 — the admin fills in real numbers in the Builder UI (the
 * whole POINT of a fee proposal is that every job's numbers are
 * different; docs/proposal-reference-content.md gives real historical
 * examples as content-STRUCTURE guidance, not dollar figures to ship
 * as real placeholder pricing on every new proposal).
 */
export function proposalTemplateContent(kind: ProposalTemplateKind): ProposalContent {
  switch (kind) {
    case "renovation":
      return {
        letter: letterFor(
          "The renovation you're planning is a considered one — {{note the key move, e.g. reworking the kitchen/living connection and resolving the bathrooms}} — and the brief you've described is exactly the kind of project we do best: a full internal transformation within an existing footprint, executed with the same rigour as a new build."
        ),
        vision: visionFor(
          "The existing plan gives us a strong starting point, and the changes you're after — {{note the specific rooms/aspects}} — are about resolving what's not working rather than starting again."
        ),
        scope_sections: RENOVATION_SCOPE,
        fees: { mode: "staged", stages: RENOVATION_FEE_STAGES, payment_lines: [
          "30% deposit on acceptance",
          "30% on Concept Design presentation",
          "30% on Design Development and Interior Detailing",
          "10% on final Documentation and Quoting",
        ] },
        timeline: RENOVATION_TIMELINE,
        exclusions: exclusionsBlock("$8,000 to $15,000"),
        terms_md: DEFAULT_TERMS_MD,
      };
    case "new_build":
      return {
        letter: letterFor(
          "A new build on this block gives us a clean slate to plan around {{note the key site opportunity, e.g. northern light, the fall of the land, an outlook to retain}} from the first sketch, rather than working around an existing structure."
        ),
        vision: visionFor(
          "Building new here means the home can be planned around how you actually want to live — {{note the specific priorities from the visit}} — from the ground up, rather than adapted to fit."
        ),
        scope_sections: NEW_BUILD_SCOPE,
        fees: { mode: "staged", stages: NEW_BUILD_FEE_STAGES, payment_lines: [
          "30% upon engagement",
          "40% upon completion of Concept Design",
          "30% prior to council lodgement",
        ] },
        timeline: NEW_BUILD_TIMELINE,
        exclusions: exclusionsBlock("$15,000 to $25,000"),
        terms_md: DEFAULT_TERMS_MD,
      };
    case "multi_phase":
    default:
      return {
        letter: letterFor(
          "Given the scale of what's ahead across the whole home, we're proposing a phased approach — a single masterplan and design direction covering every room, then detailed design and documentation delivered phase by phase, starting with {{note the priority zone}} — so the whole project reads as one considered home, not a series of disconnected renovations."
        ),
        vision: visionFor(
          "Working across the whole home in phases means every later decision is made against a single, whole-of-home design direction — {{note the specific priorities from the visit}} — rather than each zone being resolved in isolation."
        ),
        scope_sections: MULTI_PHASE_SCOPE,
        fees: { mode: "staged", stages: MULTI_PHASE_FEE_STAGES, payment_lines: [] },
        timeline: MULTI_PHASE_TIMELINE,
        exclusions: exclusionsBlock("$20,000 to $35,000"),
        terms_md: DEFAULT_TERMS_MD,
      };
  }
}
