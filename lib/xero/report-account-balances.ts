import type { XeroReport, XeroReportRow } from "@/types/xero";

export interface XeroNamedAccountBalance {
  name: string;
  balance: number;
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
 * Extract exact chart-of-account rows from a Xero report. Exact normalized
 * matching prevents section totals or similarly named accounts from being
 * mistaken for a facility balance.
 */
export function xeroReportAccountBalances(
  report: XeroReport,
  accountNames: string[]
): XeroNamedAccountBalance[] {
  const canonicalName = new Map(
    accountNames.map((name) => [normaliseName(name), name])
  );
  const balances = new Map<string, number>();
  for (const row of flatten(report.Rows)) {
    const cells = row.Cells ?? [];
    if (cells.length < 2) continue;
    const rowName = cells[0]?.Value?.trim() ?? "";
    const name = canonicalName.get(normaliseName(rowName));
    if (!name) continue;
    const balance = money(cells.at(-1)?.Value);
    if (balance === null) continue;
    balances.set(name, balance);
  }
  return [...balances].map(([name, balance]) => ({ name, balance }));
}
