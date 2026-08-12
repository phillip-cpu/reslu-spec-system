import { addCalendarDays, resolveClaimForecastDate } from "../client-claim-schedule.ts";
import type {
  ClientBillingProfile,
  ClientContractVariation,
  ClientInvoice,
  ClientPaymentScheduleItem,
  ClientSchedulePhase,
} from "../../types/client-invoices";
import type { FinanceContributionInput } from "../../types/finance";

function dollarsToMinor(value: number): number {
  const minor = Math.round((Number(value) + Number.EPSILON) * 100);
  if (!Number.isSafeInteger(minor) || minor < 0) {
    throw new Error("Client claim amount exceeds safe minor units");
  }
  return minor;
}

/** Builds money-in contributions from the same contract claims shown on the
 * project invoice screen. The contract supplies value; contract signing or
 * the linked construction phase supplies claim timing; payment terms supply
 * the expected receipt date. Issued and paid invoices replace the plan. */
export function buildClientClaimContributions(input: {
  projectId: string;
  profile: ClientBillingProfile | null;
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  invoices: ClientInvoice[];
  contractVariations?: ClientContractVariation[];
}): FinanceContributionInput[] {
  const profile = input.profile;
  if (!profile) return [];
  const invoiceById = new Map(input.invoices.map((invoice) => [invoice.id, invoice]));

  return input.schedule.flatMap((stage) => {
    const variation = stage.contract_variation_id
      ? input.contractVariations?.find((candidate) => candidate.id === stage.contract_variation_id) ?? null
      : null;
    if (stage.contract_variation_id && !variation) return [];
    const effectiveProfile: ClientBillingProfile = variation
      ? {
          ...profile,
          contract_type: "other",
          contract_label: variation.label,
          contract_amount_inc_gst: Number(variation.amount_inc_gst),
          due_days: variation.due_days,
          contract_reference: variation.reference,
          contract_signed_at: variation.approved_at,
        }
      : profile;
    const invoice = stage.client_invoice_id ? invoiceById.get(stage.client_invoice_id) : null;
    if (invoice?.status === "void") return [];

    const forecastClaimDate = resolveClaimForecastDate({
      stage,
      profile: effectiveProfile,
      phases: input.phases,
    });
    const issuedDate = invoice?.issued_at?.slice(0, 10) ?? null;
    const paidDate = invoice?.paid_at?.slice(0, 10) ?? null;
    const dueDays = invoice?.due_days ?? effectiveProfile.due_days;
    const expectedReceiptDate = addCalendarDays(
      issuedDate ?? forecastClaimDate,
      dueDays
    );
    const amountMinor = dollarsToMinor(invoice?.total_inc_gst ?? stage.amount_inc_gst);
    if (amountMinor === 0) return [];

    const isIssued = invoice?.status === "sent" || invoice?.status === "paid";
    const isPaid = invoice?.status === "paid";
    return [{
      contributionKey: `project:${input.projectId}|client_claim:${stage.id}`,
      direction: "inflow" as const,
      description: variation
        ? `Client claim — ${variation.label} — ${stage.label}`
        : `Client claim — ${stage.label}`,
      plannedMinor: amountMinor,
      actualAccruedMinor: isIssued ? amountMinor : 0,
      actualPaidMinor: isPaid ? amountMinor : 0,
      plannedDate: expectedReceiptDate,
      actualDueDate: isIssued ? expectedReceiptDate : null,
      actualPaidDate: isPaid ? paidDate : null,
      baseEligible: true,
      confidence: isPaid
        ? ("confirmed" as const)
        : isIssued
          ? ("high" as const)
          : forecastClaimDate
            ? ("medium" as const)
            : ("unknown" as const),
      sourceTrace: {
        source_type: "client_claim",
        source_record_id: stage.id,
        section_name: "Client claims",
        payment_schedule_item_id: stage.id,
        contract_variation_id: variation?.id ?? null,
        contract_package_label: variation?.label ?? profile.contract_label,
        client_invoice_id: invoice?.id ?? null,
        trigger_type: stage.trigger_type,
        schedule_phase_id: stage.schedule_phase_id,
        forecast_claim_date: forecastClaimDate,
        expected_receipt_date: expectedReceiptDate,
        timing_source:
          invoice?.status === "paid"
            ? "actual_payment"
            : invoice?.status === "sent"
              ? "issued_invoice_terms"
              : stage.trigger_type,
      },
    }];
  });
}
