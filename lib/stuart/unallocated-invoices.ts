import { createServiceRoleClient } from "@/lib/supabase/server";
import type { FinanceRecurringCategory } from "@/types/finance";

const ACCOUNTS_MAILBOX = "accounts@reslu.com.au";
const VALID_CATEGORIES = new Set<FinanceRecurringCategory>([
  "wages", "superannuation", "rent", "marketing", "entertainment",
  "software", "insurance", "utilities", "professional_fees", "vehicles", "other",
]);

type ProjectClassification = {
  invoiceId: string;
  scope: "project";
  projectId: string;
  category?: never;
  recurringCommitmentId?: never;
  humanConfirmed: boolean;
};

type CompanyClassification = {
  invoiceId: string;
  scope: "company";
  projectId?: never;
  category: FinanceRecurringCategory;
  recurringCommitmentId?: string | null;
  humanConfirmed: boolean;
};

export type ClassifyUnallocatedInvoiceInput = ProjectClassification | CompanyClassification;

export async function classifyUnallocatedInvoice(input: ClassifyUnallocatedInvoiceInput) {
  if (input.humanConfirmed !== true) {
    throw new Error("Explicit human confirmation of the project or company classification is required");
  }
  if (input.scope === "company" && !VALID_CATEGORIES.has(input.category)) {
    throw new Error("Unsupported company expense category");
  }

  const service = createServiceRoleClient();
  let recurringCommitmentId: string | null = null;
  let projectId: string | null = null;
  let category: FinanceRecurringCategory | null = null;
  if (input.scope === "project") {
    const { data: project } = await service.from("projects")
      .select("id,name,status,deleted_at").eq("id", input.projectId).single();
    if (!project || project.deleted_at || project.status === "archived") {
      throw new Error("The selected project is unavailable");
    }
    projectId = project.id;
  } else {
    category = input.category;
    recurringCommitmentId = input.recurringCommitmentId ?? null;
    if (recurringCommitmentId) {
      const { data: commitment } = await service.from("finance_recurring_commitments")
        .select("id,category,status").eq("id", recurringCommitmentId).single();
      if (!commitment || commitment.status === "archived") throw new Error("Recurring commitment is unavailable");
      if (commitment.category !== category) throw new Error("Recurring commitment category does not match the company classification");
    }
  }

  const { data: actor } = await service.from("profiles").select("id").eq("email", ACCOUNTS_MAILBOX).single();
  const { data: updated, error: updateError } = await service.rpc("classify_unallocated_supplier_invoice", {
    p_invoice_id: input.invoiceId,
    p_scope: input.scope,
    p_project_id: projectId,
    p_category: category,
    p_recurring_commitment_id: recurringCommitmentId,
    p_actor_id: actor?.id ?? null,
  });
  if (updateError || !updated) throw new Error(updateError?.message ?? "Invoice classification could not be saved");

  return {
    invoice: updated,
    xero_draft_unchanged: true,
    next_step: input.scope === "project"
      ? "Match the invoice lines to the project before Spec approval."
      : "Review the company category and any recurring-commitment link before accounting approval.",
  };
}
