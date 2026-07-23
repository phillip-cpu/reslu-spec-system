/**
 * A fee-proposal follow-up is no longer actionable once its linked
 * lead has been formally lost. The database closes outstanding
 * proposals when that stage change happens; this helper is a
 * defensive read-side guard so My Work also stays correct if it reads
 * during a deployment or encounters older data.
 */
export function suppressProposalFollowupForLeadStage(
  leadStage: string | null | undefined
): boolean {
  return leadStage === "Lead Lost";
}
