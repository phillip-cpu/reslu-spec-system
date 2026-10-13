/** Presentation only: never use this label for filtering, quotes or accounting. */
export function sowTradeDisplayHeading(section: { trade_heading_overrides?: Record<string, string> }, trade: string | null): string {
  return (trade && section.trade_heading_overrides?.[trade]?.trim()) || trade || "General";
}
export function normalizeSowHeadingOverride(value: unknown): { trade: string; heading: string | null } {
  if (!value || typeof value !== "object") throw new Error("Provide a trade and display heading.");
  const { trade, heading } = value as { trade?: unknown; heading?: unknown };
  if (typeof trade !== "string" || !trade.trim() || trade.length > 160 || ["__proto__", "constructor", "prototype"].includes(trade)) throw new Error("Invalid trade identity.");
  if (heading !== null && (typeof heading !== "string" || !heading.trim() || heading.trim().length > 160 || /[\r\n]/.test(heading))) throw new Error("Enter a display heading of 1–160 characters, or reset it.");
  return { trade, heading: heading === null ? null : (heading as string).trim() };
}
