import type { ProjectStage } from "@/types/finance";
import type { ClientContractType } from "@/types/client-invoices";

/**
 * A saved estimate is the prospective construction cost plan. It must not be
 * treated as expenditure against a design fee while the project is still a
 * design/quoting engagement.
 */
export function includesConstructionCosts(
  projectStage: ProjectStage,
  contractType: ClientContractType | null | undefined
): boolean {
  if (contractType !== "construction") return false;
  return projectStage !== "design" && projectStage !== "quoting";
}
