/**
 * RESLU Second Brain — Supabase gte-small embedding wrapper, 384 dims
 * (migration 045). Replaces the original OpenAI text-embedding-3-small
 * wrapper (1536 dims, Step 5) per a decision made in a separate Claude
 * Desktop conversation with Phillip — no artifact of that decision
 * exists in this repo, so the implementation below is this session's
 * own engineering judgment, not a copy of a brief.
 *
 * Unlike OpenAI's embeddings endpoint (a plain REST call, which is why
 * the original wrapper was just fetch()), Supabase's gte-small has no
 * public REST endpoint — it's normally only invokable from inside a
 * Supabase Edge Function's own Deno runtime. The standard way to use
 * it from an external Node environment (this app runs on Vercel, not
 * Supabase Edge Functions) is to run the actual model inference
 * in-process via a transformers.js-family package. Uses
 * `@huggingface/transformers` (the official successor to the
 * community `@xenova/transformers` package) specifically because it
 * resolved a real, critical vulnerability: `@xenova/transformers`
 * pulls in `onnxruntime-web` (browser/WASM-oriented) -> `onnx-proto`
 * -> a vulnerable `protobufjs` (arbitrary code execution,
 * GHSA-xq3m-2v4x-88gg and others). `@huggingface/transformers` uses
 * `onnxruntime-node` instead (the native Node binding, also more
 * appropriate for a server environment than a WASM build) and
 * introduces zero new vulnerabilities — confirmed via `npm audit`
 * before this file was written.
 *
 * The model is loaded once and cached at module scope (`pipelinePromise`)
 * so a warm serverless instance reuses it across invocations instead of
 * reloading on every request — same "cache expensive setup at module
 * scope" pattern already used elsewhere in this codebase (e.g. the MCP
 * server's own cached auth token). `env.cacheDir` is pointed at `/tmp`
 * explicitly — Vercel's deployment filesystem is read-only outside
 * `/tmp`, and this package downloads/caches model weights to disk on
 * first use.
 *
 * Deliberately FAILS LOUDLY (throws) on any error — matches the
 * original wrapper's own stated reasoning: a silent embedding failure
 * would leave workspace_index quietly stale with no signal, worse
 * than a cron run erroring visibly in Vercel's logs.
 */

import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

const MODEL = "Supabase/gte-small";
const BATCH_SIZE = 8;

env.cacheDir = "/tmp/hf-cache";

let pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

function getPipeline(): Promise<FeatureExtractionPipeline> {
  if (!pipelinePromise) {
    // Vercel's default Node function memory is not large enough for the fp32
    // model once ONNX has allocated its working buffers. The model repository
    // ships a q8 ONNX build with the same 384-dimensional output contract.
    pipelinePromise = pipeline("feature-extraction", MODEL, { dtype: "q8" }) as Promise<FeatureExtractionPipeline>;
  }
  return pipelinePromise;
}

/**
 * Embeds a list of texts, preserving input order. Internally batches
 * to keep per-call memory bounded — callers never need to think about
 * batching themselves.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  let extractor: FeatureExtractionPipeline;
  try {
    extractor = await getPipeline();
  } catch (err) {
    // Reset so the next call retries loading rather than replaying a cached rejection forever.
    pipelinePromise = null;
    throw new Error(`Failed to load gte-small embedding model: ${err instanceof Error ? err.message : String(err)}`);
  }

  const results: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const output = await extractor(batch, { pooling: "mean", normalize: true });
    const batchResults = output.tolist() as number[][];
    results.push(...batchResults);
  }

  return results;
}
