"use client";

import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import {
  FINANCIAL_SUMMARY_CHANGED_EVENT,
  type FinancialPositionStatus,
  type ProjectFinancialPosition,
} from "@/lib/project-financial-position";

interface Props {
  projectId: string;
}

const STATUS_PRESENTATION: Record<
  FinancialPositionStatus,
  { label: string; dot: string; text: string }
> = {
  needs_setup: {
    label: "Needs setup",
    dot: "bg-amber-500",
    text: "text-amber-800",
  },
  at_risk: {
    label: "At risk",
    dot: "bg-red-700",
    text: "text-red-700",
  },
  costs_ahead: {
    label: "Costs ahead",
    dot: "bg-amber-500",
    text: "text-amber-800",
  },
  on_track: {
    label: "On track",
    dot: "bg-emerald-700",
    text: "text-emerald-800",
  },
  billing_ahead: {
    label: "Billing ahead",
    dot: "bg-emerald-700",
    text: "text-emerald-800",
  },
};

function money(value: number): string {
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function signedMoney(value: number): string {
  if (value > 0) return `+${money(value)}`;
  return money(value);
}

function progressWidth(value: number | null): string {
  return `${Math.min(100, Math.max(0, value ?? 0))}%`;
}

function Tally({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="border-t border-[#dcd6cc] pt-4">
      <p className="label-caps mb-2">{label}</p>
      <p className="font-serif text-[1.65rem] leading-none text-nearblack">{value}</p>
      <p className="mt-2 text-small text-charcoal/55">{detail}</p>
    </div>
  );
}

function ProgressRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: number | null;
  tone: "dark" | "sand";
}) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4 text-small text-charcoal/70">
        <span>{label}</span>
        <span>{value === null ? "Not available" : `${value.toFixed(1)}%`}</span>
      </div>
      <div className="h-1.5 bg-[#e3ddd3]">
        <div
          className={clsx("h-full transition-[width]", tone === "dark" ? "bg-nearblack" : "bg-sand")}
          style={{ width: progressWidth(value) }}
        />
      </div>
    </div>
  );
}

/**
 * One project-level view of money out, money billed, money received,
 * and forecast job margin. The labels intentionally keep "issued"
 * separate from "paid": an invoice sent to a client is revenue billed,
 * not cash in the bank.
 */
export function FinancialPositionSummary({ projectId }: Props) {
  const [position, setPosition] = useState<ProjectFinancialPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/financial-summary`, {
        cache: "no-store",
      });
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error ?? "Could not load the project financial position.");
      }
      setPosition(body.financial_position);
      setError(null);
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Could not load the project financial position."
      );
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    // Initial project-scoped summary request.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load(true);

    let refreshTimer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => load(false), 75);
    };
    window.addEventListener(FINANCIAL_SUMMARY_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener(FINANCIAL_SUMMARY_CHANGED_EVENT, refresh);
      if (refreshTimer) clearTimeout(refreshTimer);
    };
  }, [load]);

  if (loading && !position) {
    return (
      <section className="border border-[#dcd6cc] bg-offwhite p-6">
        <p className="text-body text-charcoal/50">Calculating project financial position…</p>
      </section>
    );
  }

  if (error && !position) {
    return (
      <section className="border border-red-700/40 bg-red-50 p-6">
        <p className="text-body text-red-700">{error}</p>
      </section>
    );
  }

  if (!position) return null;

  const status = STATUS_PRESENTATION[position.status];
  const marginDetail =
    position.forecast_margin_pct === null
      ? "Contract or cost plan required"
      : `${position.forecast_margin_pct.toFixed(1)}% of adjusted contract`;
  const costPlanExcluded = !position.cost_plan_required;

  return (
    <section className="border border-[#c9c2b4] bg-offwhite">
      <div className="grid gap-8 border-b border-[#dcd6cc] p-6 lg:grid-cols-[1fr_auto] lg:items-start">
        <div>
          <div className="mb-3 flex flex-wrap items-center gap-3">
            <p className="label-caps">Project financial position</p>
            <span className={clsx("inline-flex items-center gap-2 text-small", status.text)}>
              <span className={clsx("h-2.5 w-2.5 rounded-full", status.dot)} />
              {status.label}
            </span>
          </div>
          <p className="max-w-2xl text-subhead text-nearblack">{position.story}</p>
          {costPlanExcluded && (
            <p className="mt-2 max-w-2xl text-small text-charcoal/60">
              The prospective build estimate is excluded while this is a design or quoting engagement.
              Approved supplier invoices are still counted.
            </p>
          )}
          {error && <p className="mt-2 text-small text-red-700">{error}</p>}
        </div>
        <div className="min-w-[220px] lg:text-right">
          <p className="label-caps mb-2">Forecast gross position</p>
          <p
            className={clsx(
              "font-serif text-[2.25rem] leading-none",
              position.forecast_margin_ex_gst < 0 ? "text-red-700" : "text-nearblack"
            )}
          >
            {signedMoney(position.forecast_margin_ex_gst)}
          </p>
          <p className="mt-2 text-small text-charcoal/55">{marginDetail} · ex GST</p>
        </div>
      </div>

      <div className="grid gap-x-6 gap-y-5 p-6 sm:grid-cols-2 xl:grid-cols-4">
        <Tally
          label="Approved supplier invoices"
          value={money(position.supplier_approved.total_ex_gst)}
          detail={`${position.supplier_approved.count} approved · ex GST`}
        />
        <Tally
          label="Client invoices issued"
          value={money(position.client_issued.total_inc_gst)}
          detail={`${position.client_issued.count} sent or paid · inc GST`}
        />
        <Tally
          label="Client payments received"
          value={money(position.client_paid.total_inc_gst)}
          detail={`${position.client_paid.count} marked paid · inc GST`}
        />
        <Tally
          label="Outstanding from client"
          value={money(position.client_outstanding.total_inc_gst)}
          detail={`${position.client_outstanding.count} sent, awaiting payment · inc GST`}
        />
        <Tally
          label="Adjusted client contract"
          value={money(position.adjusted_contract_inc_gst)}
          detail={`${money(position.approved_variations_inc_gst)} approved variations · inc GST`}
        />
        <Tally
          label={costPlanExcluded ? "Recorded design cost exposure" : "Forecast project cost"}
          value={money(position.forecast_cost_ex_gst)}
          detail={
            costPlanExcluded
              ? "Approved supplier invoices only · ex GST"
              : `${money(position.planned_cost_ex_gst)} current cost plan · ex GST`
          }
        />
        <Tally
          label="Current recorded position"
          value={signedMoney(position.current_recorded_position_ex_gst)}
          detail="Client invoices issued less approved supplier costs · ex GST"
        />
      </div>

      <div className="grid gap-6 border-t border-[#dcd6cc] p-6 lg:grid-cols-2">
        <ProgressRow
          label="Client contract billed"
          value={position.billing_progress_pct}
          tone="dark"
        />
        <ProgressRow
          label="Forecast cost approved so far"
          value={position.cost_progress_pct}
          tone="sand"
        />
      </div>

      <div className="border-t border-[#dcd6cc] bg-cream/40 px-6 py-4 text-small leading-relaxed text-charcoal/55">
        {costPlanExcluded
          ? "Forecast: adjusted design contract less approved supplier costs. The prospective construction estimate is not treated as spend against this engagement. "
          : "Forecast: adjusted contract less the current cost plan, or approved supplier costs if they have already exceeded that plan. "}
        Current recorded position compares invoices issued
        with approved supplier costs; it is not bank cash or final profit.
        {position.client_drafts.count > 0 && (
          <>
            {" "}
            {position.client_drafts.count} client invoice
            {position.client_drafts.count === 1 ? " is" : "s are"} still in draft and excluded.
          </>
        )}
      </div>
    </section>
  );
}
