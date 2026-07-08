/**
 * RESLU Second Brain, Step 5 (docs/RESLU-second-brain-build-brief.md).
 * OpenAI text-embedding-3-small wrapper — 1536 dims, must match
 * workspace_index.embedding's vector width (migration 035) and the
 * model the Step 6 search tool embeds queries with.
 *
 * Plain fetch(), not the `openai` SDK — this repo has no LLM SDK
 * dependency anywhere yet (lib/scraper/ also hand-rolls fetch for its
 * one external HTTP need), and a single embeddings endpoint call
 * doesn't justify adding one.
 *
 * Deliberately FAILS LOUDLY (throws) on any error — unlike
 * lib/scraper's "never throw, flag and continue" convention. The
 * brief is explicit about this for the indexer ("Fail loudly on any
 * error"): a silent embedding failure would leave workspace_index
 * quietly stale with no signal, which is worse than a cron run
 * erroring visibly in Vercel's logs.
 */

const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MODEL = "text-embedding-3-small";
const BATCH_SIZE = 100;

/**
 * Embeds a list of texts, preserving input order. Internally batches
 * into groups of <=100 (OpenAI's per-request limit, per the brief) —
 * callers never need to think about batching themselves.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set — cannot embed text.");
  }

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const res = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: MODEL, input: batch }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI embeddings request failed (${res.status}): ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as { data: { index: number; embedding: number[] }[] };
    // OpenAI's response ordering matches input order, but sort by the
    // returned `index` defensively rather than assume it.
    const batchResults = [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    results.push(...batchResults);
  }

  return results;
}
