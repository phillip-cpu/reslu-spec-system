import type { XeroReportKey } from "@/types/xero";

export type XeroReportDateMode = "period" | "as_at" | "published";

export interface XeroReportDefinition {
  key: XeroReportKey;
  label: string;
  endpoint: string;
  dateMode: XeroReportDateMode;
  standardLayout?: boolean;
}

export const XERO_REPORTS: readonly XeroReportDefinition[] = [
  {
    key: "profit_and_loss",
    label: "Profit & Loss",
    endpoint: "ProfitAndLoss",
    dateMode: "period",
    standardLayout: true,
  },
  {
    key: "balance_sheet",
    label: "Balance Sheet",
    endpoint: "BalanceSheet",
    dateMode: "as_at",
    standardLayout: true,
  },
  {
    key: "trial_balance",
    label: "Trial Balance",
    endpoint: "TrialBalance",
    dateMode: "as_at",
  },
  {
    key: "bank_summary",
    label: "Bank Summary",
    endpoint: "BankSummary",
    dateMode: "period",
  },
  {
    key: "budget_summary",
    label: "Budget Summary",
    endpoint: "BudgetSummary",
    dateMode: "as_at",
  },
  {
    key: "executive_summary",
    label: "Executive Summary",
    endpoint: "ExecutiveSummary",
    dateMode: "as_at",
  },
  {
    key: "bas",
    label: "Published BAS reports",
    endpoint: "",
    dateMode: "published",
  },
] as const;

export function xeroReportDefinition(key: string): XeroReportDefinition | null {
  return XERO_REPORTS.find((report) => report.key === key) ?? null;
}
