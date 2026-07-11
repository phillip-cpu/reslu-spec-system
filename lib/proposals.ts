// ============================================================
// RESLU Spec System — Fee proposal phase (r23).
// Shared helpers used by every proposals API route + the ProposalPdf
// component — totals math, deposit default, follow-up-due check,
// storage path convention. Dependency-free where possible (no
// Supabase/Next imports) so it can be unit-reasoned-about by reading,
// same convention as lib/client-invoices.ts / lib/trade-booking.ts.
// ============================================================

import { roundHalfUpCents } from "@/lib/client-invoices";
import type { Proposal, ProposalContent, ProposalFees } from "@/types/proposals";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * total_inc = sum of every fee stage's own total_inc (mode='staged') —
 * OR, when mode='single' (a flat, unstaged fee), the single stage's
 * own total_inc (there is still exactly one ProposalFeeStage row in
 * `stages` for the single flat total; `payment_lines` carries the
 * percentage/structure text, `stages[0].total_inc` carries the number
 * — see types/proposals.ts's ProposalFees doc comment). Server-computed
 * on every create/PATCH — never accepted verbatim from the client, same
 * posture as lib/client-invoices.ts's computeTotals().
 */
export function computeProposalTotal(fees: ProposalFees): number {
  const raw = (fees.stages ?? []).reduce((sum, stage) => {
    const amount = Number(stage.total_inc);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return roundHalfUpCents(raw);
}

/** Recomputes a fee stage's own total_inc as the sum of its milestones — a convenience the Builder UI calls on every milestone-amount blur so the stage total (and therefore the grand total) stays in sync without a second manual entry. Not enforced server-side (an admin CAN type a stage total that doesn't match its milestones' sum — e.g. a lump-sum stage with indicative-only milestone splits — so this is offered as a UI convenience, not a DB constraint). */
export function sumStageMilestones(stage: { milestones: { amount_inc: number }[] }): number {
  const raw = stage.milestones.reduce((sum, m) => {
    const amount = Number(m.amount_inc);
    return sum + (Number.isFinite(amount) ? amount : 0);
  }, 0);
  return roundHalfUpCents(raw);
}

/**
 * Default deposit_inc — "defaulting to 30% of total rounded to dollar"
 * (BUILD-SPEC.md item 3). Rounded to the nearest WHOLE dollar
 * (Math.round, not roundHalfUpCents' cents rounding) per that exact
 * wording — a deposit invoice line reading "$18,750" rather than
 * "$18,750.30" is the intent here.
 */
export function defaultDepositInc(totalInc: number): number {
  return Math.round(totalInc * 0.3);
}

/**
 * Ex-GST amount to feed lib/client-invoices.ts's cleanLineItems/
 * computeTotals when drafting the deposit invoice from deposit_inc
 * (which is itself INC GST — see migration 051's own column comment).
 * total_inc_gst = subtotal_ex_gst + subtotal_ex_gst * 0.1, so
 * subtotal_ex_gst = total_inc_gst / 1.1 — rounded half-up to cents,
 * same GST_RATE=0.1 convention client_invoices' own computeTotals()
 * uses, so the resulting client_invoices row's own total_inc_gst lands
 * back on (or within a cent of) deposit_inc.
 */
export function depositExGst(depositInc: number): number {
  return roundHalfUpCents(depositInc / 1.1);
}

/** >5 days sent, not yet accepted — BUILD-SPEC.md item 6: "sent >5 days not accepted -> My Work follow-ups". Mirrors lib/trade-booking.ts's isBookingRequestFollowupDue() exactly (same shape, different threshold/status set — see that function's own precedent). */
export function isProposalFollowupDue(
  proposal: { status: string; sent_at: string | null },
  now: Date = new Date()
): boolean {
  if (proposal.status !== "sent" || !proposal.sent_at) return false;
  const sentAt = new Date(proposal.sent_at);
  const dueAt = new Date(sentAt.getTime() + 5 * DAY_MS);
  return now.getTime() > dueAt.getTime();
}

/** Private `assets` bucket (ASSET_BUCKET) object key for a proposal's signed PDF — see migration 051's own header comment on bucket reuse. Timestamped so a hypothetical future re-generation never overwrites an already-emailed file (same convention as lib/signatures.ts's certificatePath()/signatureImagePath()). */
export function proposalPdfPath(proposalId: string, now: Date = new Date()): string {
  return `proposals/${proposalId}/${now.getTime()}-signed.pdf`;
}

/** "Residence" display name for the cover/emails — falls back through lead surname_project -> project name/alias -> "your project", since a proposal only ever has one of lead_id/project_id set at a time in practice (both nullable, at least one set — see migration 051's chk_proposals_lead_or_project). */
export function residenceLabel(source: {
  lead?: { surname_project?: string | null } | null;
  project?: { name?: string | null; alias?: string | null } | null;
}): string {
  if (source.project?.alias) return source.project.alias;
  if (source.project?.name) return source.project.name;
  if (source.lead?.surname_project) return source.lead.surname_project;
  return "your project";
}

/** Validates a ProposalContent shape loosely (defensive — PATCH /api/proposals/[id] is admin-only, but a malformed body should never silently corrupt the jsonb column with the wrong shape). Returns null when valid, else a human-readable reason. */
export function validateProposalContent(content: unknown): string | null {
  if (!content || typeof content !== "object") return "content must be an object";
  const c = content as Partial<ProposalContent>;
  if (typeof c.letter !== "string") return "content.letter must be a string";
  if (typeof c.vision !== "string") return "content.vision must be a string";
  if (!Array.isArray(c.scope_sections)) return "content.scope_sections must be an array";
  if (!c.fees || typeof c.fees !== "object") return "content.fees must be an object";
  if (c.fees.mode !== "staged" && c.fees.mode !== "single") return "content.fees.mode must be 'staged' or 'single'";
  if (!Array.isArray(c.fees.stages)) return "content.fees.stages must be an array";
  if (!Array.isArray(c.fees.payment_lines)) return "content.fees.payment_lines must be an array";
  if (!Array.isArray(c.timeline)) return "content.timeline must be an array";
  if (!c.exclusions || typeof c.exclusions !== "object") return "content.exclusions must be an object";
  if (!Array.isArray(c.exclusions.bullets)) return "content.exclusions.bullets must be an array";
  if (typeof c.exclusions.allowance !== "string") return "content.exclusions.allowance must be a string";
  if (typeof c.terms_md !== "string") return "content.terms_md must be a string";
  return null;
}

/** Recipient email for a proposal — lead.email when lead_id-sourced, project.client_email when project-sourced (mirrors the same lookup precedence residenceLabel() uses). Null when neither is on file — callers (POST .../send) surface that as a 400, same as client_invoices' own "no client_email on file" guard. */
export function recipientEmail(source: {
  lead?: { email?: string | null } | null;
  project?: { client_email?: string | null } | null;
}): string | null {
  return source.project?.client_email || source.lead?.email || null;
}

export type { Proposal, ProposalContent };
