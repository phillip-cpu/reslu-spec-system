export interface StuartForecastInvoice {
  invoice_type: "ACCREC" | "ACCPAY";
  status: string;
  due_date: string | null;
  amount_due: number | string | null;
}

export interface StuartCostLine {
  project_id: string;
  cost_ex_gst: number | string | null;
  quoted_to_client_ex_gst: number | string | null;
  actual_paid_ex_gst: number | string | null;
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function day(value: string): Date {
  return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
}

export function buildThirteenWeekForecast(
  openingCash: number | string | null,
  invoices: StuartForecastInvoice[],
  today: string
) {
  const start = day(today);
  const buckets = Array.from({ length: 13 }, (_, index) => {
    const from = new Date(start.getTime() + index * 7 * 86_400_000);
    const to = new Date(from.getTime() + 6 * 86_400_000);
    return {
      week: index + 1,
      from: from.toISOString().slice(0, 10),
      to: to.toISOString().slice(0, 10),
      receivables_due: 0,
      payables_due: 0,
      downside_receivables: 0,
      closing_cash_base: 0,
      closing_cash_downside: 0,
    };
  });

  for (const invoice of invoices) {
    const amount = numberValue(invoice.amount_due);
    if (amount <= 0 || !invoice.due_date || /^(paid|voided|deleted)$/i.test(invoice.status)) continue;
    const due = day(invoice.due_date);
    const baseIndex = Math.max(0, Math.floor((due.getTime() - start.getTime()) / (7 * 86_400_000)));
    if (baseIndex < buckets.length) {
      if (invoice.invoice_type === "ACCREC") buckets[baseIndex].receivables_due += amount;
      else buckets[baseIndex].payables_due += amount;
    }
    if (invoice.invoice_type === "ACCREC") {
      const downsideIndex = Math.max(0, Math.floor((due.getTime() + 14 * 86_400_000 - start.getTime()) / (7 * 86_400_000)));
      if (downsideIndex < buckets.length) buckets[downsideIndex].downside_receivables += amount;
    }
  }

  let baseCash = numberValue(openingCash);
  let downsideCash = baseCash;
  for (const bucket of buckets) {
    baseCash += bucket.receivables_due - bucket.payables_due;
    downsideCash += bucket.downside_receivables - bucket.payables_due;
    bucket.receivables_due = round(bucket.receivables_due);
    bucket.payables_due = round(bucket.payables_due);
    bucket.downside_receivables = round(bucket.downside_receivables);
    bucket.closing_cash_base = round(baseCash);
    bucket.closing_cash_downside = round(downsideCash);
  }
  return {
    basis: "Xero open invoices by due date; overdue items are placed in week 1",
    downside_assumption: "Customer receipts arrive 14 days later; supplier bills remain due on their recorded dates",
    opening_cash: round(numberValue(openingCash)),
    weeks: buckets,
  };
}

export function summariseProjectCosts(lines: StuartCostLine[]) {
  const projects = new Map<string, { project_id: string; estimated_cost_ex_gst: number; quoted_ex_gst: number; actual_ex_gst: number; lines_with_actuals: number }>();
  for (const line of lines) {
    const summary = projects.get(line.project_id) ?? {
      project_id: line.project_id,
      estimated_cost_ex_gst: 0,
      quoted_ex_gst: 0,
      actual_ex_gst: 0,
      lines_with_actuals: 0,
    };
    summary.estimated_cost_ex_gst += numberValue(line.cost_ex_gst);
    summary.quoted_ex_gst += numberValue(line.quoted_to_client_ex_gst);
    if (line.actual_paid_ex_gst != null) {
      summary.actual_ex_gst += numberValue(line.actual_paid_ex_gst);
      summary.lines_with_actuals += 1;
    }
    projects.set(line.project_id, summary);
  }
  return [...projects.values()].map((summary) => ({
    ...summary,
    estimated_cost_ex_gst: round(summary.estimated_cost_ex_gst),
    quoted_ex_gst: round(summary.quoted_ex_gst),
    actual_ex_gst: round(summary.actual_ex_gst),
    actual_vs_estimated_ex_gst: round(summary.actual_ex_gst - summary.estimated_cost_ex_gst),
    quoted_less_actual_ex_gst: round(summary.quoted_ex_gst - summary.actual_ex_gst),
  }));
}
