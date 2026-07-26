"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import type {
  ClientApprovedVariation,
  ClientBillingProfile,
  ClientContractType,
  ClientInvoice,
  ClientInvoiceStatus,
  ClientPaymentScheduleItem,
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

interface Props {
  projectId: string;
  /** Prefills the "New invoice" composer's client fields — the invoice
   * still stores its OWN snapshot of these (migration 046's own column
   * comments), so editing the project's client details later never
   * rewrites an already-created invoice. */
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
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
  stripeConfigured,
}: Props) {
  const [invoices, setInvoices] = useState<ClientInvoice[]>([]);
  const [billingProfile, setBillingProfile] = useState<ClientBillingProfile | null>(null);
  const [paymentSchedule, setPaymentSchedule] = useState<ClientPaymentScheduleItem[]>([]);
  const [approvedVariations, setApprovedVariations] = useState<ClientApprovedVariation[]>([]);
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
      setApprovedVariations(body.approved_variations ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load client invoices.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

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
      await load();
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
        key={`${billingProfile?.updated_at ?? "new"}-${paymentSchedule.map((stage) => stage.updated_at ?? stage.id).join("-")}`}
        projectId={projectId}
        profile={billingProfile}
        schedule={paymentSchedule}
        variations={approvedVariations}
        onSaved={load}
        onError={setError}
      />

      <ComposerForm
        projectId={projectId}
        projectClientName={projectClientName}
        projectClientEmail={projectClientEmail}
        projectAddress={projectAddress}
        billingProfile={billingProfile}
        paymentSchedule={paymentSchedule}
        onCreated={load}
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
  linked: boolean;
};

const DESIGN_STAGES = [
  ["Deposit — due on execution of the Design Agreement", 30],
  ["Phase 1 — Masterplan approval", 20],
  ["Phase 2 — Council lodgement", 10],
  ["Phase 3 — Design development approval", 30],
  ["Final documentation package", 10],
] as const;

const CONSTRUCTION_STAGES = [
  ["Deposit — due on execution of the Construction Contract", 30],
  ["Demolition complete", 20],
  ["First fix complete", 20],
  ["Tiling complete", 20],
  ["Practical completion", 10],
] as const;

function BillingSetup({
  projectId,
  profile,
  schedule,
  variations,
  onSaved,
  onError,
}: {
  projectId: string;
  profile: ClientBillingProfile | null;
  schedule: ClientPaymentScheduleItem[];
  variations: ClientApprovedVariation[];
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
      linked: Boolean(stage.client_invoice_id),
    }))
  );
  const [saving, setSaving] = useState(false);

  function applyPreset(type: "design" | "construction") {
    const total = Number(contractAmount) || 0;
    const preset = type === "design" ? DESIGN_STAGES : CONSTRUCTION_STAGES;
    setContractType(type);
    setContractLabel(type === "design" ? "Design package" : "Construction package");
    setDueDays(type === "design" ? "14" : "7");
    setStages(
      preset.map(([label, percentage]) => ({
        label,
        percentage: String(percentage),
        amount_inc_gst: (Math.round(total * percentage) / 100).toFixed(2),
        milestone_date: "",
        linked: false,
      }))
    );
  }

  function updateStage(index: number, patch: Partial<EditableStage>) {
    setStages((current) => current.map((stage, i) => (i === index ? { ...stage, ...patch } : stage)));
  }

  const scheduleTotal = stages.reduce((sum, stage) => sum + (Number(stage.amount_inc_gst) || 0), 0);
  const contractTotal = Number(contractAmount) || 0;
  const variationsTotal = variations.reduce((sum, variation) => sum + variation.amount_inc_gst, 0);

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
              {schedule.length} package claims · {profile.due_days}-day terms
              {variations.length
                ? ` · ${formatMoney(variationsTotal)} approved variations shown separately`
                : " · no approved variations"}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="border border-[#c9c2b4] px-3 py-1.5 text-caption text-charcoal hover:border-nearblack"
          >
            Edit schedule
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
            Enter the signed package inclusive of GST. Invoices claim one milestone, never the individual products inside it.
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
          Use RESLU construction stages
        </button>
        <button
          type="button"
          onClick={() =>
            setStages((current) => [
              ...current,
              { label: "", percentage: "", amount_inc_gst: "", milestone_date: "", linked: false },
            ])
          }
          className="border border-[#c9c2b4] px-3 py-1.5 text-caption"
        >
          + Add custom stage
        </button>
      </div>

      <div className="space-y-2">
        {stages.map((stage, index) => (
          <div key={stage.id ?? index} className="grid grid-cols-12 gap-2 border-b border-[#e5e0d6] pb-2">
            <input
              disabled={stage.linked}
              value={stage.label}
              onChange={(event) => updateStage(index, { label: event.target.value })}
              placeholder="Package milestone"
              className="col-span-12 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55 md:col-span-5"
            />
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
              className="col-span-3 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55 md:col-span-1"
            />
            <input
              disabled={stage.linked}
              type="number"
              step="0.01"
              value={stage.amount_inc_gst}
              onChange={(event) => updateStage(index, { amount_inc_gst: event.target.value })}
              placeholder="Amount inc GST"
              className="col-span-5 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55 md:col-span-3"
            />
            <input
              disabled={stage.linked}
              type="date"
              value={stage.milestone_date}
              onChange={(event) => updateStage(index, { milestone_date: event.target.value })}
              className="col-span-4 border border-[#c9c2b4] bg-nearwhite px-2 py-1.5 text-body disabled:opacity-55 md:col-span-2"
            />
            <button
              type="button"
              disabled={stage.linked}
              onClick={() => setStages((current) => current.filter((_, i) => i !== index))}
              className="col-span-12 text-left text-caption text-red-700 disabled:text-charcoal/35 md:col-span-1"
            >
              {stage.linked ? "Invoiced" : "Remove"}
            </button>
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
        </div>
        <button
          type="button"
          disabled={saving || stages.length === 0 || Math.abs(scheduleTotal - contractTotal) > 0.01}
          onClick={save}
          className="bg-nearblack px-5 py-2 text-subhead text-white disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save contract schedule"}
        </button>
      </div>
    </div>
  );
}

function ComposerForm({
  projectId,
  projectClientName,
  projectClientEmail,
  projectAddress,
  billingProfile,
  paymentSchedule,
  onCreated,
  onError,
}: {
  projectId: string;
  projectClientName: string;
  projectClientEmail: string | null;
  projectAddress: string | null;
  billingProfile: ClientBillingProfile | null;
  paymentSchedule: ClientPaymentScheduleItem[];
  onCreated: () => void;
  onError: (msg: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [entryMode, setEntryMode] = useState<"reslu" | "manual">("reslu");
  const [manualInvoiceNumber, setManualInvoiceNumber] = useState("");
  const [manualStatus, setManualStatus] = useState<"sent" | "paid">("sent");
  const [issuedDate, setIssuedDate] = useState(adelaideToday);
  const [paidDate, setPaidDate] = useState(adelaideToday);
  const [dueDate, setDueDate] = useState("");
  const [clientName, setClientName] = useState(projectClientName);
  const [clientEmail, setClientEmail] = useState(projectClientEmail ?? "");
  const [address, setAddress] = useState(projectAddress ?? "");
  const [notes, setNotes] = useState("");
  const [scheduleItemId, setScheduleItemId] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const availableStages = paymentSchedule.filter((stage) => !stage.client_invoice_id);
  const selectedStage = availableStages.find((stage) => stage.id === scheduleItemId) ?? null;

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
        : billingProfile?.due_days ?? 14;
    setSubmitting(true);
    onError(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-invoices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: billingProfile?.contract_type === "design" ? "design_fee" : "other",
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
      onCreated();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not create invoice.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={!billingProfile || availableStages.length === 0}
          onClick={() => {
            setEntryMode("reslu");
            setOpen(true);
          }}
          title={!billingProfile ? "Set up the contract schedule first" : availableStages.length === 0 ? "All package stages have been invoiced" : undefined}
          className="border border-nearblack px-5 py-2 text-subhead text-nearblack transition-colors hover:bg-nearblack hover:text-white disabled:opacity-40"
        >
          + Create RESLU invoice
        </button>
        <button
          type="button"
          disabled={!billingProfile || availableStages.length === 0}
          onClick={() => {
            setEntryMode("manual");
            setOpen(true);
          }}
          className="border border-[#c9c2b4] px-5 py-2 text-subhead text-charcoal transition-colors hover:border-nearblack disabled:opacity-40"
        >
          + Record existing invoice
        </button>
      </div>
    );
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
          onClick={() => setOpen(false)}
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
            {billingProfile?.due_days ?? 14} days
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
              {stage.label} — {formatMoney(stage.amount_inc_gst)} inc GST
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
          Contract {formatMoney(billingProfile?.contract_amount_inc_gst ?? 0)} inc GST · variations and the full payment position will appear separately on the PDF.
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
