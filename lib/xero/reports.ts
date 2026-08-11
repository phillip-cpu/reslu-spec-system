import { getActiveXeroConnection, xeroGet } from "@/lib/xero/client";
import { xeroReportDefinition } from "@/lib/xero/report-definitions";
import type { XeroReportKey, XeroReportResult } from "@/types/xero";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!ISO_DATE.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error("Report dates must use YYYY-MM-DD");
  }
  return value;
}

export async function pullXeroReport(input: {
  report: XeroReportKey;
  fromDate?: string;
  toDate?: string;
  date?: string;
}): Promise<XeroReportResult> {
  const definition = xeroReportDefinition(input.report);
  if (!definition) throw new Error("Unsupported Xero report");
  const connection = await getActiveXeroConnection();
  if (!connection) throw new Error("Xero is not connected");

  const fromDate = validDate(input.fromDate);
  const toDate = validDate(input.toDate);
  const date = validDate(input.date);
  if (fromDate && toDate && fromDate > toDate) {
    throw new Error("Report start date must be before the end date");
  }

  const query: Record<string, string> = {};
  if (definition.dateMode === "period") {
    if (fromDate) query.fromDate = fromDate;
    if (toDate) query.toDate = toDate;
  }
  if (definition.dateMode === "as_at" && date) query.date = date;
  if (definition.standardLayout) query.standardLayout = "true";
  if (definition.key === "budget_summary") {
    query.periods = "12";
    query.timeframe = "1";
  }

  const endpoint = definition.endpoint ? `/${definition.endpoint}` : "";
  const body = await xeroGet<{ Reports?: XeroReportResult["reports"] }>(
    connection,
    `api.xro/2.0/Reports${endpoint}`,
    query
  );
  return {
    key: definition.key,
    label: definition.label,
    retrieved_at: new Date().toISOString(),
    reports: Array.isArray(body.Reports) ? body.Reports : [],
  };
}
