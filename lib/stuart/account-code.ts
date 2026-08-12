type XeroHistoryRow = { contact_name?: string | null; raw_json?: unknown };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Historical codes are only safe when every observed line for the exact
 * supplier agrees. One conflicting code makes the result deliberately null. */
export function inferSingleExpenseAccountCode(rows: XeroHistoryRow[], supplier: string): string | null {
  const wanted = supplier.trim().toLocaleLowerCase("en-AU");
  const codes = new Set<string>();
  for (const row of rows) {
    if ((row.contact_name ?? "").trim().toLocaleLowerCase("en-AU") !== wanted) continue;
    const raw = row.raw_json as Record<string, unknown> | null;
    const lines = Array.isArray(raw?.LineItems) ? raw.LineItems : [];
    for (const line of lines) {
      const code = text((line as Record<string, unknown>)?.AccountCode);
      if (/^\d{3,10}$/.test(code)) codes.add(code);
    }
  }
  return codes.size === 1 ? [...codes][0] : null;
}
