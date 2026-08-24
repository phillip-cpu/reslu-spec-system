"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  addCalendarDays,
  plannedClaimTimingState,
  resolveTemplateSchedulePhaseId,
  resolveClaimForecastDate,
} from "@/lib/client-claim-schedule";
import { FINANCIAL_SUMMARY_CHANGED_EVENT } from "@/lib/project-financial-position";
import {
  DEFAULT_PROJECT_TYPE,
  FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES,
  PROJECT_TYPE_LABELS,
  isProjectType,
  type ProjectType,
} from "@/lib/project-templates";
import type {
  ClientApprovedVariation,
  ClientBillingProfile,
  ClientContractVariation,
  ClientContractType,
  ClientInvoice,
  ClientInvoiceStatus,
  ClientPaymentScheduleItem,
  ClientPaymentTriggerType,
  ClientSchedulePhase,
} from "@/types/client-invoices";

const STATUS_STYLES: Record<ClientInvoiceStatus, string> = {
  draft: "border-[#c9c2b4] text-charcoal/60",
  sent: "border-sand text-sand",
  paid: "border-nearblack bg-nearblack text-white",
  void: "border-red-700/40 text-red-700",
};

function formatMoney(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatDate(value: string | null): string {
  if (!value) return "Not linked";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

interface Props {
  projectId: string;
  /** Prefills the "New invoice" composer's client fields — the invoice
   * still stores its OWN snapshot of these (migration 046's own column
   * comments), so editing the project's client details later never
   * rewrites an already-created invoice. */
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
  projectType: ProjectType | null;
  /** Server-computed (process.env.STRIPE_SECRET_KEY presence) — gates
   * whether "Create payment link" is even offered per row, same
   * "booleans computed server-side, never the raw env exposed"
   * convention as components/settings/IntegrationStatus.tsx. */
  stripeConfigured: boolean;
}

/**
 * "Client invoices" section of the project Invoices tab — money IN
 * (RESLU bills the client), sitting alongside (not replacing) the
 * existing supplier InvoiceQueue on the same page (money OUT). Admin-
 * only, same gating shape as InvoiceQueue.tsx: the page itself already
 * blocks non-admins before this component ever mounts, and every API
 * route this component calls independently re-checks admin too.
 *
 * BUILD-SPEC.md this round: "Global /invoices list? SKIP v1
 * (project-scoped only, document)" — there is deliberately no
 * cross-project client-invoices view yet; this component only ever
 * queries ONE project's invoices.
 */
export function ClientInvoiceQueue({
  projectId,
  projectClientName,
  projectClientEmail,
  projectAddress,
  projectType,
  stripeConfigured,
}: Props) {
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [billingProfile, setBillingProfile] = useState<ClientBillingProfile | null>(null);
  const [paymentSchedule, setPaymentSchedule] = useState<ClientPaymentScheduleItem[]>([]);
  const [schedulePhases, setSchedulePhases] = useState<ClientSchedulePhase[]>([]);
  const [approvedVariations, setApprovedVariations] = useState<ClientApprovedVariation[]>([]);
  const [contractVariations, setContractVariations] = useState<ClientContractVariation[]>([]);
  const [composerRequest, setComposerRequest] = useState<{
    stageId: string;
    mode: "reslu" | "manual";
    nonce: number;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-invoices`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not load client invoices.");
      setInvoices(body.invoices ?? []);
      setBillingProfile(body.billing_profile ?? null);
      setPaymentSchedule(body.payment_schedule ?? []);
      setSchedulePhases(body.schedule_phases ?? []);
      setApprovedVariations(body.approved_variations ?? []);
      setContractVariations(body.contract_variations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load client invoices.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  const refreshFinancialSummary = useCallback(async () => {
    await load();
    window.dispatchEvent(new Event(FINANCIAL_SUMMARY_CHANGED_EVENT));
  }, [load]);

  useEffect(() => {
    // Fetching this project-scoped queue is the effect's external synchronization.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function runAction(id: string, action: "send" | "resend" | "mark-paid" | "void" | "stripe-link") {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/client-invoices/${id}/${action}`, { method: "POST" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `Could not ${action.replace("-", " ")} invoice.`);
      if (body.warning) setError(body.warning);
      await refreshFinancialSummary();
    } catch (err) {
      setError(err instanceof Error ? err.message : `Could not ${action.replace("-", " ")} invoice.`);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      {error && (
        <p className="border border-red-700/40 bg-red-50 px-4 py-2 text-body text-red-700">{error}</p>
      )}

      <BillingSetup
        key={`${billingProfile?.updated_at ?? "new"}-${paymentSchedule.map((stage) => stage.updated_at ?? stage.id).join("-")}-${schedulePhases.map((phase) => `${phase.id}:${phase.end_date}`).join("-")}`}
        projectId={projectId}
        profile={billingProfile}
        schedule={paymentSchedule.filter((stage) => !stage.contract_variation_id)}
        phases={schedulePhases}
        variations={approvedVariations}
        projectType={projectType}
        onSaved={refreshFinancialSummary}
        onError={setError}
      />

      {billingProfile ? (
        <VariationPackages
          projectId={projectId}
          variations={contractVariations}
          schedule={paymentSchedule}
          phases={schedulePhases}
          invoices={invoices}
          onSaved={refreshFinancialSummary}
          onCreate={(stageId, mode) => setComposerRequest({ stageId, mode, nonce: Date.now() })}
          onError={setError}
        />
      ) : null}

      {billingProfile && paymentSchedule.some((stage) => !stage.contract_variation_id) ? (
        <ContractClaimsOverview
          profile={billingProfile}
          schedule={paymentSchedule.filter((stage) => !stage.contract_variation_id)}
          phases={schedulePhases}
          invoices={invoices}
          onCreate={(stageId, mode) =>
            setComposerRequest({ stageId, mode, nonce: Date.now() })
          }
        />
      ) : null}

      <ComposerForm
        key={composerRequest?.nonce ?? "closed-composer"}
        projectId={projectId}
        projectClientName={projectClientName}
        projectClientEmail={projectClientEmail}
        projectAddress={projectAddress}
        billingProfile={billingProfile}
        paymentSchedule={paymentSchedule}
        contractVariations={contractVariations}
        initiallyOpen={Boolean(composerRequest)}
        initialEntryMode={composerRequest?.mode ?? "reslu"}
        initialScheduleItemId={composerRequest?.stageId ?? ""}
        onClosed={() => setComposerRequest(null)}
        onCreated={refreshFinancialSummary}
        onError={setError}
      />

      {loading ? (
        <p className="text-body text-charcoal/50">Loading client invoices…</p>
      ) : invoices.length === 0 ? (
        <p className="border border-dashed border-[#c9c2b4] p-8 text-center text-body text-charcoal/50">
          No client invoices yet.
        </p>
      ) : (
        <div className="overflow-x-auto border border-[#dcd6cc]">
          <table className="w-full min-w-[900px] border-collapse">
            <thead>
              <tr className="border-b border-[#dcd6cc] bg-cream text-left">
                <th className="label-caps px-2 py-1.5">Number</th>
                <th className="label-caps px-2 py-1.5">Client</th>
                <th className="label-caps px-2 py-1.5">Source</th>
                <th className="label-caps px-2 py-1.5 text-right">Total (inc GST)</th>
                <th className="label-caps px-2 py-1.5">Status</th>
                <th className="label-caps px-2 py-1.5">Issued</th>
                <th className="label-caps px-2 py-1.5">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="border-b border-[#e5e0d6] align-top">
                  <td className="px-2 py-1.5 text-body text-nearblack">{inv.invoice_number}</td>
                  <td className="px-2 py-1.5 text-body">{inv.client_name}</td>
                  <td className="px-2 py-1.5">
                    <span className="label-caps border border-[#c9c2b4] px-1.5 py-0.5 text-charcoal/60">
                      {inv.source === "manual" ? "Recorded" : "RESLU"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right text-body">{formatMoney(inv.total_inc_gst)}</td>
                  <td className="px-2 py-1.5">
                    <span className={clsx("label-caps border px-1.5 py-0.5", STATUS_STYLES[inv.status])}>
                      {inv.status}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-body text-charcoal/70">
                    {inv.issued_at ? new Date(inv.issued_at).toLocaleDateString("en-AU") : "—"}
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex flex-wrap gap-2">
                      {inv.source !== "manual" && (
                        <a
                          href={`/api/client-invoices/${inv.id}/pdf`}
                          target="_blank"
                          rel="noreferrer"
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white"
                        >
                          Preview PDF
                        </a>
                      )}
                      {inv.source !== "manual" && inv.status === "draft" && (
                        <button
                          type="button"
                          disabled={busyId === inv.id || !inv.client_email}
                          title={!inv.client_email ? "Add a client email before sending" : undefined}
                          onClick={() => runAction(inv.id, "send")}
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Send
                        </button>
                      )}
                      {inv.source !== "manual" && inv.status === "sent" && (
                        <button
                          type="button"
                          disabled={busyId === inv.id || !inv.client_email}
                          title={
                            !inv.client_email
                              ? "Add a client email before resending"
                              : "Re-email the client with the current PDF — e.g. after creating a payment link"
                          }
                          onClick={() => runAction(inv.id, "resend")}
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Resend
                        </button>
                      )}
                      {(inv.status === "draft" || inv.status === "sent") && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => runAction(inv.id, "mark-paid")}
                          className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Mark paid
                        </button>
                      )}
                      {inv.source !== "manual" && stripeConfigured && (inv.status === "draft" || inv.status === "sent") && !inv.stripe_payment_url && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => runAction(inv.id, "stripe-link")}
                          className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
                        >
                          Create payment link
                        </button>
                      )}
                      {(inv.status === "draft" || inv.status === "sent") && (
                        <button
                          type="button"
                          disabled={busyId === inv.id}
                          onClick={() => {
                            if (confirm("Void this invoice? The number can never be reused.")) {
                              runAction(inv.id, "void");
                            }
                          }}
                          className="border border-red-700/40 px-2 py-1 text-caption text-red-700 hover:bg-red-700 hover:text-white disabled:opacity-40"
                        >
                          Void
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function adelaideToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Adelaide",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

type EditableStage = {
  id?: string;
  label: string;
  percentage: string;
  amount_inc_gst: string;
  milestone_date: string;
  trigger_type: ClientPaymentTriggerType;
  schedule_phase_id: string;
  linked: boolean;
};

const DESIGN_STAGES = [
  ["Deposit — due on execution of the Design Agreement", 30],
  ["Phase 1 — Masterplan approval", 20],
  ["Phase 2 — Council lodgement", 10],
  ["Phase 3 — Design development approval", 30],
  ["Final documentation package", 10],
] as const;

function BillingSetup({
  projectId,
  profile,
  schedule,
  phases,
  variations,
  projectType,
  onSaved,
  onError,
}: {
  projectId: string;
  profile: ClientBillingProfile | null;
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  variations: ClientApprovedVariation[];
  projectType: ProjectType | null;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [open, setOpen] = useState(!profile);
  const [contractType, setContractType] = useState<ClientContractType>(profile?.contract_type ?? "design");
  const [contractLabel, setContractLabel] = useState(profile?.contract_label ?? "Design package");
  const [contractAmount, setContractAmount] = useState(String(profile?.contract_amount_inc_gst ?? ""));
  const [dueDays, setDueDays] = useState(String(profile?.due_days ?? 14));
  const [stages, setStages] = useState<EditableStage[]>(() =>
    schedule.map((stage) => ({
      id: stage.id,
      label: stage.label,
      percentage: stage.percentage === null ? "" : String(stage.percentage),
      amount_inc_gst: String(stage.amount_inc_gst),
      milestone_date: stage.milestone_date ?? "",
      trigger_type: stage.trigger_type ?? "manual",
      schedule_phase_id: stage.schedule_phase_id ?? "",
      linked: Boolean(stage.client_invoice_id),
    }))
  );
  const [saving, setSaving] = useState(false);

  function applyPreset(type: "design" | "construction") {
    const total = Number(contractAmount) || 0;
    const resolvedProjectType = isProjectType(projectType) ? projectType : DEFAULT_PROJECT_TYPE;
    const preset = type === "design"
      ? DESIGN_STAGES.map(([label, percentage]) => ({ label, percentage, phaseName: null }))
      : FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[resolvedProjectType];
    setContractType(type);
    setContractLabel(type === "design" ? "Design package" : "Construction package");
    setDueDays(type === "design" ? "14" : "7");
    setStages(
      preset.map(({ label, percentage, phaseName }, index) => ({
        label,
        percentage: String(percentage),
        amount_inc_gst: (Math.round(total * percentage) / 100).toFixed(2),
        milestone_date: "",
        trigger_type: index === 0 ? "contract_signed" : "schedule_phase",
        schedule_phase_id:
          index === 0 ? "" : resolveTemplateSchedulePhaseId(phaseName, label, phases) ?? "",
        linked: false,
      }))
    );
  }

  function updateStage(index: number, patch: Partial<EditableStage>) {
    setStages((current) => current.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)));
  }

  const scheduleTotal = stages.reduce((sum, stage) => sum + (Number(stage.amount_inc_gst) || 0), 0);
  const contractTotal = Number(contractAmount) || 0;
  const missingProgramLinks = stages.filter(
    (stage) => stage.trigger_type === "schedule_phase" && !stage.schedule_phase_id
  ).length;

  async function save() {
    setSaving(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-billing`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contract_type: contractType,
          contract_label: contractLabel,
          contract_amount_inc_gst: contractTotal,
          due_days: Number(dueDays),
          payment_schedule: stages.map((stage, sort) => ({
            id: stage.id,
            label: stage.label,
            percentage: stage.percentage ? Number(stage.percentage) : null,
            amount_inc_gst: Number(stage.amount_inc_gst),
            milestone_date: stage.milestone_date || null,
            trigger_type: stage.trigger_type,
            schedule_phase_id: stage.schedule_phase_id || null,
            sort,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save client billing.");
      setOpen(false);
      onSaved();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not save client billing.");
    } finally {
      setSaving(false);
    }
  }

  if (!open && profile) {
    return (
      <div className="border border-[#dcd6cc] bg-offwhite p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="label-caps">Contract & payment schedule</p>
            <p className="mt-1 text-subhead text-nearblack">
              {profile.contract_label} · {formatMoney(profile.contract_amount_inc_gst)} inc GST
            </p>
            <p className="mt-1 text-caption text-charcoal/55">
              {schedule.length} contract claims · {schedule.filter((stage) => stage.trigger_type !== "manual" || stage.milestone_date).length} timed · {profile.due_days}-day terms
              {variations.length
                ? ` · ${variations.length} approved estimate variation${variations.length === 1 ? "" : "s"} tracked in Estimate`
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            Edit claims
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps">Contract & payment schedule</p>
          <p className="mt-1 text-caption text-charcoal/55">
            The contract controls each amount. Link the claim to the project program so its forecast date moves with the work.
          </p>
        </div>
        {profile ? (
          <button type="button" onClick={() => setOpen(false)} className="text-caption text-charcoal/50">
            Cancel
          </button>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <label>
          <p className="label-caps mb-1">Contract type</p>
          <select
            value={contractType}
            onChange={(event) => setContractType(event.target.value as ClientContractType)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body"
          >
            <option value="design">Design</option>
            <option value="construction">Construction</option>
            <option value="other">Other package</option>
          </select>
        </label>
        <label>
          <p className="label-caps mb-1">Package name</p>
          <input
            value={contractLabel}
            onChange={(event) => setContractLabel(event.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body"
          />
        </label>
        <label>
          <p className="label-caps mb-1">Original contract inc GST</p>
          <input
            type="number"
            min="0"
            step="0.01"
            value={contractAmount}
            onChange={(event) => setContractAmount(event.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body"
          />
        </label>
        <label>
          <p className="label-caps mb-1">Payment terms (days)</p>
          <input
            type="number"
            min="0"
            value={dueDays}
            onChange={(event) => setDueDays(event.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body"
          />
        </label>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => applyPreset("design")} className="border border-[#c9c2b4] px-3 py-1.5 text-caption">
          Use RESLU design stages
        </button>
        <button type="button" onClick={() => applyPreset("construction")} className="border border-[#c9c2b4] px-3 py-1.5 text-caption">
          Use {PROJECT_TYPE_LABELS[isProjectType(projectType) ? projectType : DEFAULT_PROJECT_TYPE]} stages
        </button>
        <button
          type="button"
          onClick={() =>
            setStages((current) => [
              ...current,
              {
                label: "",
                percentage: "",
                amount_inc_gst: "",
                milestone_date: "",
                trigger_type: "schedule_phase",
                schedule_phase_id: "",
                linked: false,
              },
            ])
          }
          className="border border-[#c9c2b4] px-3 py-1.5 text-caption"
        >
          + Add custom stage
        </button>
      </div>

      {contractType === "construction" && (
        <p className="text-caption text-charcoal/55">
          Construction percentages are editable starting assumptions. Joinery stays visible as its own major milestone; replace its illustrative percentage with the signed, cost-loaded package value before saving.
        </p>
      )}

      <div className="space-y-3">
        {stages.map((stage, index) => (
          <div key={stage.id ?? index} className="border-b border-[#e5e0d6] pb-3">
            <div className="grid grid-cols-12 gap-2">
              <label className="col-span-12 md:col-span-5">
                <span className="label-caps mb-1 block">Claim milestone</span>
                <input
                  disabled={stage.linked}
                  value={stage.label}
                  onChange={(event) => updateStage(index, { label: event.target.value })}
                  placeholder="e.g. First fix"
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                />
              </label>
              <label className="col-span-4 md:col-span-2">
                <span className="label-caps mb-1 block">%</span>
                <input
                  disabled={stage.linked}
                  type="number"
                  step="0.01"
                  value={stage.percentage}
                  onChange={(event) => {
                    const percentage = event.target.value;
                    updateStage(index, {
                      percentage,
                      amount_inc_gst: percentage
                        ? (Math.round(contractTotal * Number(percentage)) / 100).toFixed(2)
                        : stage.amount_inc_gst,
                    });
                  }}
                  placeholder="%"
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                />
              </label>
              <label className="col-span-8 md:col-span-4">
                <span className="label-caps mb-1 block">Claim amount inc GST</span>
                <input
                  disabled={stage.linked}
                  type="number"
                  step="0.01"
                  value={stage.amount_inc_gst}
                  onChange={(event) => updateStage(index, { amount_inc_gst: event.target.value })}
                  placeholder="Amount inc GST"
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                />
              </label>
              <button
                type="button"
                disabled={stage.linked}
                onClick={() => setStages((current) => current.filter((_, i) => i !== index))}
                className="col-span-12 self-end py-2 text-left text-caption text-red-700 disabled:text-charcoal/35 md:col-span-1"
              >
                {stage.linked ? "Issued" : "Remove"}
              </button>
            </div>
            <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-[220px_minmax(0,1fr)]">
              <label>
                <span className="label-caps mb-1 block">Claim timing</span>
                <select
                  disabled={stage.linked}
                  value={stage.trigger_type}
                  onChange={(event) =>
                    updateStage(index, {
                      trigger_type: event.target.value as ClientPaymentTriggerType,
                      schedule_phase_id: "",
                      milestone_date: "",
                    })
                  }
                  className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                >
                  <option value="contract_signed">When contract is signed</option>
                  <option value="schedule_phase">From construction schedule</option>
                  <option value="manual">Fixed manual date</option>
                </select>
              </label>
              {stage.trigger_type === "schedule_phase" ? (
                <label>
                  <span className="label-caps mb-1 block">Linked construction stage</span>
                  <select
                    disabled={stage.linked}
                    value={stage.schedule_phase_id}
                    onChange={(event) => updateStage(index, { schedule_phase_id: event.target.value })}
                    className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                  >
                    <option value="">Choose a stage from this project…</option>
                    {phases.map((phase) => (
                      <option key={phase.id} value={phase.id}>
                        {phase.name} — ends {formatDate(phase.end_date)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : stage.trigger_type === "manual" ? (
                <label>
                  <span className="label-caps mb-1 block">Forecast claim date</span>
                  <input
                    disabled={stage.linked}
                    type="date"
                    value={stage.milestone_date}
                    onChange={(event) => updateStage(index, { milestone_date: event.target.value })}
                    className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55"
                  />
                </label>
              ) : (
                <div>
                  <span className="label-caps mb-1 block">Forecast claim date</span>
                  <p className="border border-[#dcd6cc] bg-cream px-2 py-1.5 text-body text-charcoal/65">
                    {profile?.contract_signed_at
                      ? formatDate(profile.contract_signed_at)
                      : "Add the signed date in Finance → Project setup"}
                  </p>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#e5e0d6] pt-3">
        <div>
          <p className="text-body">
            Schedule {formatMoney(scheduleTotal)} · Contract {formatMoney(contractTotal)}
          </p>
          <p className={clsx("text-caption", Math.abs(scheduleTotal - contractTotal) <= 0.01 ? "text-green-800" : "text-red-700")}>
            {Math.abs(scheduleTotal - contractTotal) <= 0.01
              ? "Schedule balances to the signed contract."
              : "The schedule must equal the original contract amount."}
          </p>
          {missingProgramLinks > 0 ? (
            <p className="mt-1 text-caption text-red-700">
              Link {missingProgramLinks} claim{missingProgramLinks === 1 ? "" : "s"} to the construction schedule before saving.
            </p>
          ) : null}
        </div>
        <button
          type="button"
          disabled={
            saving ||
            stages.length === 0 ||
            Math.abs(scheduleTotal - contractTotal) > 0.01 ||
            missingProgramLinks > 0
          }
          onClick={save}
          className="bg-nearblack px-5 py-2 text-subhead text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save contract claims"}
        </button>
      </div>
    </div>
  );
}

function VariationPackages({
  projectId,
  variations,
  schedule,
  phases,
  invoices,
  onSaved,
  onCreate,
  onError,
}: {
  projectId: string;
  variations: ClientContractVariation[];
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  invoices: ClientInvoice[];
  onSaved: () => void;
  onCreate: (stageId: string, mode: "reslu" | "manual") => void;
  onError: (message: string | null) => void;
}) {
  const [editingId, setEditingId] = useState<string | "new" | null>(null);

  return (
    <section className="space-y-4 border border-[#dcd6cc] bg-cream/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="label-caps">Additional contract packages</p>
          <h3 className="mt-1 font-display text-[26px] font-light text-nearblack">Variations on top of the original package</h3>
          <p className="mt-1 max-w-3xl text-body text-charcoal/60">
            Each variation stays inside this project but has its own value, payment milestones and claim timing. Finance adds it to the original contract total.
          </p>
        </div>
        <button type="button" onClick={() => setEditingId("new")} className="bg-nearblack px-4 py-2 text-subhead text-white hover:bg-charcoal">
          + Add variation package
        </button>
      </div>

      {editingId === "new" ? (
        <VariationPackageEditor
          projectId={projectId}
          variation={null}
          schedule={[]}
          phases={phases}
          onCancel={() => setEditingId(null)}
          onSaved={() => { setEditingId(null); onSaved(); }}
          onError={onError}
        />
      ) : null}

      {variations.map((variation) => {
        const packageSchedule = schedule.filter((stage) => stage.contract_variation_id === variation.id);
        const profile: ClientBillingProfile = {
          project_id: variation.project_id,
          contract_type: "other",
          contract_label: variation.label,
          contract_amount_inc_gst: variation.amount_inc_gst,
          due_days: variation.due_days,
          contract_reference: variation.reference,
          contract_signed_at: variation.approved_at,
        };
        return (
          <div key={variation.id} className="space-y-3 border border-[#dcd6cc] bg-offwhite p-4">
            {editingId === variation.id ? (
              <VariationPackageEditor
                projectId={projectId}
                variation={variation}
                schedule={packageSchedule}
                phases={phases}
                onCancel={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); onSaved(); }}
                onError={onError}
              />
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="label-caps">Variation package</p>
                    <p className="mt-1 text-subhead text-nearblack">{variation.label} · {formatMoney(variation.amount_inc_gst)} inc GST</p>
                    <p className="mt-1 text-caption text-charcoal/55">
                      {packageSchedule.length} claims · {variation.due_days}-day terms{variation.approved_at ? ` · approved ${formatDate(variation.approved_at)}` : " · approval date not set"}
                    </p>
                  </div>
                  <button type="button" onClick={() => setEditingId(variation.id)} className="border border-[#c9c2b4] px-3 py-1.5 text-caption hover:border-nearblack">Edit variation</button>
                </div>
                {packageSchedule.length ? (
                  <ContractClaimsOverview profile={profile} schedule={packageSchedule} phases={phases} invoices={invoices} onCreate={onCreate} compact />
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}

function VariationPackageEditor({
  projectId, variation, schedule, phases, onCancel, onSaved, onError,
}: {
  projectId: string;
  variation: ClientContractVariation | null;
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  onCancel: () => void;
  onSaved: () => void;
  onError: (message: string | null) => void;
}) {
  const [label, setLabel] = useState(variation?.label ?? "Variation 01");
  const [amount, setAmount] = useState(String(variation?.amount_inc_gst ?? ""));
  const [dueDays, setDueDays] = useState(String(variation?.due_days ?? 7));
  const [reference, setReference] = useState(variation?.reference ?? "");
  const [approvedAt, setApprovedAt] = useState(variation?.approved_at ?? "");
  const [stages, setStages] = useState<EditableStage[]>(() => schedule.length ? schedule.map((stage) => ({
    id: stage.id, label: stage.label, percentage: stage.percentage == null ? "" : String(stage.percentage),
    amount_inc_gst: String(stage.amount_inc_gst), milestone_date: stage.milestone_date ?? "",
    trigger_type: stage.trigger_type, schedule_phase_id: stage.schedule_phase_id ?? "", linked: Boolean(stage.client_invoice_id),
  })) : [{ label: "Variation claim", percentage: "100", amount_inc_gst: "", milestone_date: "", trigger_type: "manual", schedule_phase_id: "", linked: false }]);
  const [saving, setSaving] = useState(false);
  const total = Number(amount) || 0;
  const scheduleTotal = stages.reduce((sum, stage) => sum + (Number(stage.amount_inc_gst) || 0), 0);

  function updateStage(index: number, patch: Partial<EditableStage>) {
    setStages((current) => current.map((stage, i) => i === index ? { ...stage, ...patch } : stage));
  }

  async function save() {
    setSaving(true); onError(null);
    try {
      const url = variation
        ? `/api/projects/${projectId}/client-billing/variations/${variation.id}`
        : `/api/projects/${projectId}/client-billing/variations`;
      const res = await fetch(url, {
        method: variation ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label, amount_inc_gst: total, due_days: Number(dueDays), reference: reference || null,
          approved_at: approvedAt || null,
          payment_schedule: stages.map((stage, sort) => ({
            id: stage.id, label: stage.label, percentage: stage.percentage ? Number(stage.percentage) : null,
            amount_inc_gst: Number(stage.amount_inc_gst), milestone_date: stage.milestone_date || null,
            trigger_type: stage.trigger_type, schedule_phase_id: stage.schedule_phase_id || null, sort,
          })),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not save variation package");
      onSaved();
    } catch (error) { onError(error instanceof Error ? error.message : "Could not save variation package"); }
    finally { setSaving(false); }
  }

  async function remove() {
    if (!variation || !confirm(`Delete ${variation.label}?`)) return;
    const res = await fetch(`/api/projects/${projectId}/client-billing/variations/${variation.id}`, { method: "DELETE" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { onError(body.error ?? "Could not delete variation package"); return; }
    onSaved();
  }

  return (
    <div className="space-y-4 border-t border-[#dcd6cc] pt-4">
      <div className="grid gap-3 md:grid-cols-5">
        <label className="md:col-span-2"><span className="label-caps mb-1 block">Variation name</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Radio Athens · Variation 01" className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
        <label><span className="label-caps mb-1 block">Value inc GST</span><input type="number" min="0" step="0.01" value={amount} onChange={(e) => { setAmount(e.target.value); if (stages.length === 1 && !stages[0].linked) updateStage(0, { amount_inc_gst: e.target.value }); }} className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
        <label><span className="label-caps mb-1 block">Approved date</span><input type="date" value={approvedAt} onChange={(e) => setApprovedAt(e.target.value)} className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
        <label><span className="label-caps mb-1 block">Terms (days)</span><input type="number" min="0" value={dueDays} onChange={(e) => setDueDays(e.target.value)} className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
      </div>
      <label><span className="label-caps mb-1 block">Reference (optional)</span><input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Signed variation / quote reference" className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body" /></label>
      <div className="space-y-3">
        {stages.map((stage, index) => (
          <div key={stage.id ?? index} className="grid gap-2 border border-[#e5e0d6] p-3 md:grid-cols-[2fr_1fr_1fr_2fr_auto]">
            <input disabled={stage.linked} value={stage.label} onChange={(e) => updateStage(index, { label: e.target.value })} placeholder="Claim milestone" className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55" />
            <input disabled={stage.linked} type="number" value={stage.percentage} onChange={(e) => { const pct=e.target.value; updateStage(index, { percentage:pct, amount_inc_gst:pct ? (Math.round(total*Number(pct))/100).toFixed(2) : stage.amount_inc_gst }); }} placeholder="%" className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55" />
            <input disabled={stage.linked} type="number" step="0.01" value={stage.amount_inc_gst} onChange={(e) => updateStage(index, { amount_inc_gst:e.target.value })} placeholder="Amount" className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55" />
            <div className="grid grid-cols-2 gap-2">
              <select disabled={stage.linked} value={stage.trigger_type} onChange={(e) => updateStage(index, { trigger_type:e.target.value as ClientPaymentTriggerType, schedule_phase_id:"", milestone_date:"" })} className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55">
                <option value="contract_signed">On approval</option><option value="schedule_phase">Timeline phase</option><option value="manual">Fixed date</option>
              </select>
              {stage.trigger_type === "schedule_phase" ? <select disabled={stage.linked} value={stage.schedule_phase_id} onChange={(e) => updateStage(index,{schedule_phase_id:e.target.value})} className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55"><option value="">Choose phase…</option>{phases.map((phase)=><option key={phase.id} value={phase.id}>{phase.name}</option>)}</select> : stage.trigger_type === "manual" ? <input disabled={stage.linked} type="date" value={stage.milestone_date} onChange={(e)=>updateStage(index,{milestone_date:e.target.value})} className="border border-[#c9c2b4] bg-white px-2 py-1.5 text-body disabled:opacity-55" /> : <span className="px-2 py-1.5 text-caption text-charcoal/55">{approvedAt ? formatDate(approvedAt) : "Set approval date"}</span>}
            </div>
            <button type="button" disabled={stage.linked} onClick={() => setStages((current)=>current.filter((_,i)=>i!==index))} className="text-caption text-red-700 disabled:text-charcoal/35">{stage.linked ? "Issued" : "Remove"}</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setStages((current)=>[...current,{label:"",percentage:"",amount_inc_gst:"",milestone_date:"",trigger_type:"manual",schedule_phase_id:"",linked:false}])} className="border border-[#c9c2b4] px-3 py-1.5 text-caption">+ Add payment stage</button>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[#dcd6cc] pt-3">
        <p className={clsx("text-body", Math.abs(scheduleTotal-total)<=0.01 ? "text-green-800" : "text-red-700")}>Schedule {formatMoney(scheduleTotal)} · Variation {formatMoney(total)}</p>
        <div className="flex gap-2">{variation ? <button type="button" onClick={remove} className="px-3 py-2 text-caption text-red-700">Delete</button> : null}<button type="button" onClick={onCancel} className="border border-[#c9c2b4] px-4 py-2 text-caption">Cancel</button><button type="button" disabled={saving || Math.abs(scheduleTotal-total)>0.01} onClick={save} className="bg-nearblack px-4 py-2 text-subhead text-white disabled:opacity-40">{saving ? "Saving…" : "Save variation"}</button></div>
      </div>
    </div>
  );
}

function ContractClaimsOverview({
  profile,
  schedule,
  phases,
  invoices,
  onCreate,
  compact = false,
}: {
  profile: ClientBillingProfile;
  schedule: ClientPaymentScheduleItem[];
  phases: ClientSchedulePhase[];
  invoices: ClientInvoice[];
  onCreate: (stageId: string, mode: "reslu" | "manual") => void;
  compact?: boolean;
}) {
  const today = adelaideToday();

  return (
    <section className={clsx("border border-[#dcd6cc] bg-offwhite", compact && "mt-3")}>
      <div className="border-b border-[#dcd6cc] p-4">
        <p className="label-caps">Contract claims & payments</p>
        <p className="mt-1 text-body text-charcoal/60">
          Contract values are fixed here. Construction-program dates drive the forecast and move automatically when the program moves.
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[940px] border-collapse">
          <thead>
            <tr className="border-b border-[#dcd6cc] bg-cream text-left">
              <th className="label-caps px-3 py-2">Contract milestone</th>
              <th className="label-caps px-3 py-2 text-right">Amount</th>
              <th className="label-caps px-3 py-2">Linked project event</th>
              <th className="label-caps px-3 py-2">Forecast claim</th>
              <th className="label-caps px-3 py-2">Expected receipt</th>
              <th className="label-caps px-3 py-2">Status / next action</th>
            </tr>
          </thead>
          <tbody>
            {schedule.map((stage) => {
              const phase = phases.find((candidate) => candidate.id === stage.schedule_phase_id) ?? null;
              const forecastDate = resolveClaimForecastDate({ stage, profile, phases });
              const invoice = invoices.find((candidate) => candidate.id === stage.client_invoice_id) ?? null;
              const issuedDate = invoice?.issued_at?.slice(0, 10) ?? null;
              const expectedReceipt = invoice?.paid_at?.slice(0, 10) ??
                addCalendarDays(issuedDate ?? forecastDate, invoice?.due_days ?? profile.due_days);
              const timingState = plannedClaimTimingState(forecastDate, today);
              const timingLabel =
                stage.trigger_type === "contract_signed"
                  ? profile.contract_type === "other" ? "Variation approved" : "Contract signed"
                  : stage.trigger_type === "schedule_phase"
                    ? phase?.name ?? "Choose construction stage"
                    : "Manual date";
              const statusLabel = invoice
                ? invoice.status === "paid"
                  ? "Paid"
                  : invoice.status === "sent"
                    ? "Issued · awaiting payment"
                    : invoice.status === "draft"
                      ? "Draft claim"
                      : "Voided"
                : timingState === "review"
                  ? "Review claim"
                  : timingState === "planned"
                    ? "Planned"
                    : "Needs timing link";

              return (
                <tr key={stage.id} className="border-b border-[#e5e0d6] align-top last:border-b-0">
                  <td className="px-3 py-3">
                    <p className="text-body text-nearblack">{stage.label}</p>
                    {stage.percentage !== null ? (
                      <p className="mt-0.5 text-caption text-charcoal/45">{stage.percentage}% of package</p>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-right text-body text-nearblack">
                    {formatMoney(stage.amount_inc_gst)}
                  </td>
                  <td className="px-3 py-3">
                    <p className="text-body text-nearblack">{timingLabel}</p>
                    {phase ? (
                      <p className="mt-0.5 text-caption text-charcoal/45">
                        Program {formatDate(phase.start_date)} → {formatDate(phase.end_date)}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-3 py-3 text-body">
                    {invoice?.issued_at ? formatDate(issuedDate) : formatDate(forecastDate)}
                  </td>
                  <td className="px-3 py-3 text-body">
                    {invoice?.paid_at ? `Paid ${formatDate(invoice.paid_at.slice(0, 10))}` : formatDate(expectedReceipt)}
                  </td>
                  <td className="px-3 py-3">
                    <span
                      className={clsx(
                        "label-caps inline-block border px-2 py-1",
                        invoice?.status === "paid"
                          ? "border-nearblack bg-nearblack text-white"
                          : invoice?.status === "sent" || timingState === "review"
                            ? "border-sand text-[#76570a]"
                            : timingState === "needs_link"
                              ? "border-red-700/35 text-red-700"
                              : "border-[#c9c2b4] text-charcoal/60"
                      )}
                    >
                      {statusLabel}
                    </span>
                    {!invoice ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button
                          type="button"
                          disabled={timingState === "needs_link"}
                          onClick={() => onCreate(stage.id, "reslu")}
                          title={timingState === "needs_link" ? "Link this claim to a project event first" : undefined}
                          className="border border-nearblack px-2 py-1 text-caption text-nearblack hover:bg-nearblack hover:text-white disabled:cursor-not-allowed disabled:opacity-35"
                        >
                          Create claim
                        </button>
                        <button
                          type="button"
                          onClick={() => onCreate(stage.id, "manual")}
                          className="border border-[#c9c2b4] px-2 py-1 text-caption text-charcoal hover:border-nearblack"
                        >
                          Record existing
                        </button>
                      </div>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ComposerForm({
  projectId,
  projectClientName,
  projectClientEmail,
  projectAddress,
  billingProfile,
  paymentSchedule,
  contractVariations,
  initiallyOpen,
  initialEntryMode,
  initialScheduleItemId,
  onClosed,
  onCreated,
  onError,
}: {
  projectId: string;
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
  billingProfile: ClientBillingProfile | null;
  paymentSchedule: ClientPaymentScheduleItem[];
  contractVariations: ClientContractVariation[];
  initiallyOpen: boolean;
  initialEntryMode: "reslu" | "manual";
  initialScheduleItemId: string;
  onClosed: () => void;
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const entryMode = initialEntryMode;
  const [manualInvoiceNumber, setManualInvoiceNumber] = useState("");
  const [manualStatus, setManualStatus] = useState<"sent" | "paid">("sent");
  const [issuedDate, setIssuedDate] = useState(adelaideToday);
  const [paidDate, setPaidDate] = useState(adelaideToday);
  const [dueDate, setDueDate] = useState("");
  const [clientName, setClientName] = useState(projectClientName);
  const [clientEmail, setClientEmail] = useState(projectClientEmail ?? "");
  const [address, setAddress] = useState(projectAddress ?? "");
  const [notes, setNotes] = useState("");
  const [scheduleItemId, setScheduleItemId] = useState(initialScheduleItemId);
  const [submitting, setSubmitting] = useState(false);

  const availableStages = paymentSchedule.filter((stage) => !stage.client_invoice_id);
  const selectedStage = availableStages.find((stage) => stage.id === scheduleItemId) ?? null;
  const selectedVariation = selectedStage?.contract_variation_id
    ? contractVariations.find((variation) => variation.id === selectedStage.contract_variation_id) ?? null
    : null;
  const effectiveDueDays = selectedVariation?.due_days ?? billingProfile?.due_days ?? 14;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!clientName.trim()) {
      onError("Client name is required.");
      return;
    }
    if (!selectedStage) {
      onError("Choose the package stage this invoice is claiming.");
      return;
    }
    if (entryMode === "manual" && (!manualInvoiceNumber.trim() || !issuedDate)) {
      onError("Invoice number and issued date are required when recording an existing invoice.");
      return;
    }
    if (entryMode === "manual" && manualStatus === "paid" && !paidDate) {
      onError("Paid date is required for a paid invoice.");
      return;
    }
    const manualDueDays =
      entryMode === "manual" && issuedDate && dueDate
        ? Math.max(
            0,
            Math.round(
              (new Date(`${dueDate}T00:00:00Z`).getTime() -
                new Date(`${issuedDate}T00:00:00Z`).getTime()) /
                86_400_000
            )
          )
        : effectiveDueDays;
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: !selectedVariation && billingProfile?.contract_type === "design" ? "design_fee" : "other",
          source: entryMode,
          invoice_number: entryMode === "manual" ? manualInvoiceNumber.trim() : undefined,
          status: entryMode === "manual" ? manualStatus : undefined,
          issued_at:
            entryMode === "manual" ? `${issuedDate}T00:00:00Z` : undefined,
          paid_at:
            entryMode === "manual" && manualStatus === "paid"
              ? `${paidDate}T00:00:00Z`
              : undefined,
          payment_schedule_item_id: selectedStage.id,
          client_name: clientName.trim(),
          client_email: clientEmail.trim() || null,
          address: address.trim() || null,
          due_days: manualDueDays,
          notes: notes.trim() || null,
          line_items: [
            {
              description: selectedStage.label,
              amount_ex_gst: Math.round((selectedStage.amount_inc_gst / 1.1) * 100) / 100,
            },
          ],
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? "Could not create invoice.");
      setManualInvoiceNumber("");
      setManualStatus("sent");
      setIssuedDate(adelaideToday());
      setPaidDate(adelaideToday());
      setDueDate("");
      setScheduleItemId("");
      setNotes("");
      setOpen(false);
      onClosed();
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create invoice.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return null;
  }

  return (
    <form onSubmit={submit} className="space-y-4 border border-[#dcd6cc] bg-offwhite p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="label-caps">
            {entryMode === "manual" ? "Record existing client invoice" : "Create RESLU client invoice"}
          </p>
          <p className="mt-1 text-caption text-charcoal/55">
            {entryMode === "manual"
              ? "Use the original invoice number and dates. This records money in without re-sending the invoice."
              : "Creates a numbered RESLU draft that can be previewed and emailed to the client."}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            onClosed();
          }}
          className="text-caption text-charcoal/50 hover:text-nearblack"
        >
          Cancel
        </button>
      </div>

      {entryMode === "manual" && (
        <div className="grid grid-cols-1 gap-3 border border-[#dcd6cc] bg-nearwhite p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block">
            <p className="label-caps mb-1">Original invoice #</p>
            <input
              required
              value={manualInvoiceNumber}
              onChange={(e) => setManualInvoiceNumber(e.target.value)}
              className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <label className="block">
            <p className="label-caps mb-1">Issued date</p>
            <input
              required
              type="date"
              value={issuedDate}
              onChange={(e) => setIssuedDate(e.target.value)}
              className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
            />
          </label>
          <label className="block">
            <p className="label-caps mb-1">Payment status</p>
            <select
              value={manualStatus}
              onChange={(e) => setManualStatus(e.target.value as "sent" | "paid")}
              className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
            >
              <option value="sent">Outstanding</option>
              <option value="paid">Paid</option>
            </select>
          </label>
          {manualStatus === "paid" ? (
            <label className="block">
              <p className="label-caps mb-1">Paid date</p>
              <input
                required
                type="date"
                value={paidDate}
                onChange={(e) => setPaidDate(e.target.value)}
                className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
          ) : (
            <label className="block">
              <p className="label-caps mb-1">Due date</p>
              <input
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                className="w-full border border-[#c9c2b4] bg-white px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
              />
            </label>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <p className="label-caps mb-1">Client name</p>
          <input
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <label className="block">
          <p className="label-caps mb-1">Client email</p>
          <input
            type="email"
            value={clientEmail}
            onChange={(e) => setClientEmail(e.target.value)}
            className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
          />
        </label>
        <div>
          <p className="label-caps mb-1">Payment terms</p>
          <p className="border border-[#c9c2b4] bg-cream px-2 py-1.5 text-body">
            {effectiveDueDays} days
          </p>
        </div>
      </div>

      <label className="block">
        <p className="label-caps mb-1">Address</p>
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
      </label>

      <label className="block border border-[#dcd6cc] bg-cream p-3">
        <p className="label-caps mb-1">Package stage being invoiced</p>
        <select
          required
          value={scheduleItemId}
          onChange={(event) => setScheduleItemId(event.target.value)}
          className="w-full border border-[#c9c2b4] bg-white px-2 py-2 text-body"
        >
          <option value="">Choose an uninvoiced package stage…</option>
          {availableStages.map((stage) => (
            <option key={stage.id} value={stage.id}>
              {stage.contract_variation_id ? `${contractVariations.find((variation) => variation.id === stage.contract_variation_id)?.label ?? "Variation"} · ` : ""}{stage.label} — {formatMoney(stage.amount_inc_gst)} inc GST
            </option>
          ))}
        </select>
        {selectedStage ? (
          <p className="mt-2 text-body text-charcoal/65">
            The tax invoice will show this as one package claim: {formatMoney(selectedStage.amount_inc_gst)} inc GST.
          </p>
        ) : null}
      </label>

      <label className="block">
        <p className="label-caps mb-1">Notes (optional)</p>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="w-full border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body focus:border-nearblack focus:outline-none"
        />
      </label>

      <div className="flex items-center justify-between border-t border-[#e5e0d6] pt-3">
        <p className="text-caption text-charcoal/60">
          {selectedVariation
            ? `${selectedVariation.label} · ${formatMoney(selectedVariation.amount_inc_gst)} inc GST`
            : `Original contract ${formatMoney(billingProfile?.contract_amount_inc_gst ?? 0)} inc GST`}
        </p>
        <button
          type="submit"
          disabled={submitting}
          className="bg-nearblack px-5 py-2 text-subhead text-white transition-colors hover:bg-charcoal disabled:opacity-60"
        >
          {submitting
            ? "Saving…"
            : entryMode === "manual"
              ? "Record invoice"
              : "Create draft"}
        </button>
      </div>
    </form>
  );
}
