import { buildClientClaimContributions } from "./client-claims.ts";
import type {
  ClientBillingProfile,
  ClientContractVariation,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../../types/client-invoices";
import type { FinanceContributionInput } from "../../types/finance";

export interface CompanyClientClaimProjectSummary {
  projectId: string;
  claimCount: number;
  contractedMinor: number;
  issuedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  forecastRemainingMinor: number;
}

export interface CompanyClientClaimSummary {
  projectCount: number;
  claimCount: number;
  contractedMinor: number;
  issuedMinor: number;
  paidMinor: number;
  outstandingMinor: number;
  forecastRemainingMinor: number;
}

/**
 * Builds the company money-in portfolio directly from saved client contracts.
 * Finance activation is deliberately absent from this input: actual receipts,
 * issued claims and linked future milestones are cash facts regardless of
 * whether a cost baseline has been locked for the project.
 */
export function buildCompanyClientClaimPortfolio(input: {
  profiles: ClientBillingProfile[];
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  invoices: ClientInvoice[];
  projectNames?: Map<string, string>;
  contractVariations?: ClientContractVariation[];
}): {
  contributions: FinanceContributionInput[];
  projects: CompanyClientClaimProjectSummary[];
  summary: CompanyClientClaimSummary;
} {
  const projects = input.profiles.map((profile) => {
    const projectId = profile.project_id;
    const contributions = buildClientClaimContributions({
      projectId,
      profile,
      schedule: input.schedule.filter((stage) => stage.project_id === projectId),
      phases: input.phases.filter((phase) => phase.project_id === projectId),
      invoices: input.invoices.filter((invoice) => invoice.project_id === projectId),
      contractVariations: input.contractVariations?.filter(
        (variation) => variation.project_id === projectId && variation.status === "active"
      ),
    }).map((contribution) => ({
      ...contribution,
      sourceTrace: {
        ...contribution.sourceTrace,
        project_id: projectId,
        project_name: input.projectNames?.get(projectId) ?? "Project",
      },
    }));

    const contractedMinor = contributions.reduce(
      (sum, contribution) => sum + contribution.plannedMinor,
      0
    );
    const issuedMinor = contributions.reduce(
      (sum, contribution) => sum + (contribution.actualAccruedMinor ?? 0),
      0
    );
    const paidMinor = contributions.reduce(
      (sum, contribution) => sum + (contribution.actualPaidMinor ?? 0),
      0
    );

    return {
      projectId,
      contributions,
      claimCount: contributions.length,
      contractedMinor,
      issuedMinor,
      paidMinor,
      outstandingMinor: Math.max(issuedMinor - paidMinor, 0),
      forecastRemainingMinor: Math.max(contractedMinor - issuedMinor, 0),
    };
  });

  const contributions = projects.flatMap((project) => project.contributions);
  const projectSummaries = projects.map(({ contributions: _contributions, ...project }) => project);
  const summary = projectSummaries.reduce<CompanyClientClaimSummary>(
    (total, project) => ({
      projectCount: total.projectCount + (project.claimCount > 0 ? 1 : 0),
      claimCount: total.claimCount + project.claimCount,
      contractedMinor: total.contractedMinor + project.contractedMinor,
      issuedMinor: total.issuedMinor + project.issuedMinor,
      paidMinor: total.paidMinor + project.paidMinor,
      outstandingMinor: total.outstandingMinor + project.outstandingMinor,
      forecastRemainingMinor: total.forecastRemainingMinor + project.forecastRemainingMinor,
    }),
    {
      projectCount: 0,
      claimCount: 0,
      contractedMinor: 0,
      issuedMinor: 0,
      paidMinor: 0,
      outstandingMinor: 0,
      forecastRemainingMinor: 0,
    }
  );

  return { contributions, projects: projectSummaries, summary };
}
