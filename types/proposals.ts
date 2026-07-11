// ============================================================
// RESLU Spec System — Fee proposal phase (r23).
// Types for `proposals` (supabase/migrations/051_proposals.sql) and its
// API routes. Kept in its own file per this codebase's house
// convention of one types/<feature>.ts file per round, rather than
// editing the shared types/index.ts (protected, out of this round's
// edit boundary) — see types/client-invoices.ts / types/visit-emails.ts
// for the same convention, documented there.
// ============================================================

export type ProposalStatus = "draft" | "sent" | "accepted" | "closed";
export type ProposalTemplateKind = "renovation" | "new_build" | "multi_phase";
export type ProposalFeesMode = "staged" | "single";

/** One scope-of-services section (BUILD-SPEC.md item 1: "scope_sections[{title, intro?, bullets[], deliverables[]}]"). */
export interface ProposalScopeSection {
  title: string;
  /** Optional short lead-in paragraph before the bullets — most template sections omit it. */
  intro?: string;
  bullets: string[];
  /** Rendered with a "→" arrow per item, both in the client page and the PDF — see docs/proposal-reference-content.md "each: bullets + 'Deliverables' list with → arrows". */
  deliverables: string[];
}

/** One milestone/payment line within a fee stage. */
export interface ProposalFeeMilestone {
  label: string;
  /** Dollars, inc GST. */
  amount_inc: number;
}

/** One fee stage — "Stage 1 - $25,927.00 Inc" style, or a percentage-form stage (Greenwith/Alley) — either way `total_inc` is the stage's own inc-GST dollar total and `milestones` are its payment-structure lines. */
export interface ProposalFeeStage {
  label: string;
  /** Dollars, inc GST — the stage's own total. */
  total_inc: number;
  milestones: ProposalFeeMilestone[];
}

export interface ProposalFees {
  /** 'staged' — Neave-style multi-phase stages, each with its own total + milestones. 'single' — one flat fee with a payment_lines percentage/structure list only (no separate per-stage totals). */
  mode: ProposalFeesMode;
  stages: ProposalFeeStage[];
  /** Free-text payment-structure lines shown under the fee stages — e.g. "30% deposit on acceptance", "30% Concept presentation". Always rendered; used as the PRIMARY payment structure list when mode='single'. */
  payment_lines: string[];
}

export interface ProposalTimelineRow {
  phase: string;
  duration: string;
}

export interface ProposalExclusions {
  bullets: string[];
  /** e.g. "For budgeting purposes, we recommend allowing $15,000 to $25,000 plus GST for external consultants. RESLU coordinates and manages all external consultants as part of the project delivery." */
  allowance: string;
}

/** The full jsonb document stored on proposals.content — see migration 051's own column comment. */
export interface ProposalContent {
  letter: string;
  vision: string;
  scope_sections: ProposalScopeSection[];
  fees: ProposalFees;
  timeline: ProposalTimelineRow[];
  exclusions: ProposalExclusions;
  terms_md: string;
}

/** Signature evidence captured by POST /api/proposal/[token]/accept — see migration 051's own column comment for why the drawn PNG lives inside this blob rather than a separate storage-path column. */
export interface ProposalSignature {
  drawn_data_url: string;
  typed_name: string;
  consent: true;
  ip: string | null;
  user_agent: string | null;
}

export interface Proposal {
  id: string;
  lead_id: string | null;
  project_id: string | null;
  token: string;
  status: ProposalStatus;
  content: ProposalContent;
  total_inc: number;
  deposit_inc: number;
  viewed_at: string | null;
  sent_at: string | null;
  signed_name: string | null;
  signed_at: string | null;
  signature: ProposalSignature | null;
  signed_pdf_path: string | null;
  created_at: string;
  updated_at: string;
}

/** POST /api/proposals body. */
export interface CreateProposalInput {
  lead_id?: string | null;
  project_id?: string | null;
  template: ProposalTemplateKind;
}

/** PATCH /api/proposals/[id] body — full-content-blob replace (matches the Builder UI's draft-commit-on-blur save, which always sends the whole content object, never a per-field patch — see components/proposals/ProposalEditor.tsx's own comment for why). deposit_inc is independently patchable (a plain editable field, not re-derived from content). */
export interface PatchProposalInput {
  content?: ProposalContent;
  deposit_inc?: number;
}

/** PATCH /api/proposals/[id]/draft body — Aria's set_proposal_draft MCP tool ONLY, ONLY while status='draft'. Deliberately narrower than PatchProposalInput above (letter/vision only) — see that route's own doc comment. */
export interface PatchProposalDraftInput {
  letter?: string;
  vision?: string;
}

export interface ProposalListResponse {
  proposals: Proposal[];
}

export interface ProposalResponse {
  proposal: Proposal;
}

/** POST /api/proposal/[token]/accept body. */
export interface AcceptProposalInput {
  drawn_data_url: string;
  typed_name: string;
  consent: boolean;
}

export interface AcceptProposalResponse {
  ok: true;
  status: "accepted";
  already_accepted: boolean;
}

/** GET /proposal/[token] server-side read shape — the client page's own fetch of the full document (public, service-role). */
export interface PublicProposalView {
  proposal: Proposal;
  residence: string;
  address: string | null;
  client_name: string;
}
