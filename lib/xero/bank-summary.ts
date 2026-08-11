import type { XeroReport, XeroReportRow } from "@/types/xero";

export interface XeroBankAccountIdentity {
  name: string;
  bankAccountType: string | null;
}

export interface XeroBankSummaryBalance {
  cashBalance: number;
  creditBalance: number;
  cashAccountCount: number;
  creditAccountCount: number;
  unmatchedAccountCount: number;
}

function normaliseName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function money(value: string | undefined): number | null {
  const text = value?.trim();
  if (!text || text === "-") return null;
  const negative = text.startsWith("(") && text.endsWith(")");
  const parsed = Number(text.replace(/[,$()\s]/g, ""));
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function flatten(rows: XeroReportRow[] | undefined): XeroReportRow[] {
  return (rows ?? []).flatMap((row) => [row, ...flatten(row.Rows)]);
}

/**
 * Reads the closing-balance column of Xero's Bank Summary. Account metadata
 * comes from the Accounts endpoint, so CREDITCARD rows are never presented as
 * available cash even though Xero includes them in the report total.
 */
export function calculateBankSummaryBalance(
  report: XeroReport,
  accounts: XeroBankAccountIdentity[]
): XeroBankSummaryBalance {
  const accountTypeByName = new Map(
    accounts.map((account) => [normaliseName(account.name), account.bankAccountType?.toUpperCase() ?? null])
  );
  let cashBalance = 0;
  let creditBalance = 0;
  let cashAccountCount = 0;
  let creditAccountCount = 0;
  let unmatchedAccountCount = 0;

  for (const row of flatten(report.Rows)) {
    const cells = row.Cells ?? [];
    if (cells.length < 2) continue;
    const name = cells[0]?.Value?.trim() ?? "";
    if (!name || /^(bank accounts|total)$/i.test(name)) continue;
    const closing = money(cells.at(-1)?.Value);
    if (closing === null) continue;
    const accountType = accountTypeByName.get(normaliseName(name));
    if (accountType === "CREDITCARD") {
      creditBalance += closing;
      creditAccountCount += 1;
    } else {
      cashBalance += closing;
      cashAccountCount += 1;
      if (accountType === undefined) unmatchedAccountCount += 1;
    }
  }

  return {
    cashBalance: Math.round((cashBalance + Number.EPSILON) * 100) / 100,
    creditBalance: Math.round((creditBalance + Number.EPSILON) * 100) / 100,
    cashAccountCount,
    creditAccountCount,
    unmatchedAccountCount,
  };
}
