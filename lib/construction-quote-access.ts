/** Server-only release gate: preview builds stay off until explicitly enabled. */
export async function constructionQuoteWritesReady(
  db: { rpc: (name: string) => PromiseLike<{ data: unknown; error: unknown }> },
  enabled = process.env.RESLU_CONSTRUCTION_QUOTES_ENABLED,
): Promise<boolean> {
  if (enabled !== "1") return false;
  try {
    const { data, error } = await db.rpc("construction_quote_runtime_ready");
    return !error && data === true;
  } catch { return false; }
}
export const QUOTE_NOT_READY = "Construction quote editing is not enabled for this environment.";
