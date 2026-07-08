import type { SupabaseClient } from "@supabase/supabase-js";
import { callClaude, type ClaudeTool } from "@/lib/second-brain/claude";

/**
 * RESLU Second Brain, Step 10 (docs/RESLU-second-brain-build-brief.md).
 * The 5-rung matching ladder — stop at first confident hit:
 *   1. domain prior (sender's email domain -> items.supplier_email's
 *      domain -> exact name match within that supplier's items only)
 *   2. entity_aliases / exact name, case-insensitive, unscoped
 *   3. pg_trgm similarity (trigram_match(), migration 039)
 *   4. workspace_index embedding similarity (reuses Step 6's
 *      hybrid_search() directly rather than a second search function)
 *   5. Claude adjudication over the combined rung 3+4 candidate pool,
 *      only when there's more than one plausible candidate with no
 *      clear single winner
 *
 * Confidence bands (the brief's own): >=0.90 auto-link, 0.60-0.90
 * review, <0.60 no_match — applied by the caller (the match route),
 * not here; this module just returns a confidence + method + the
 * candidate pool considered.
 */

export type MatchEntityType = "project" | "item";

export type MatchCandidate = { entity_id: string; name: string; score: number };

export type MatchResult = {
  entityId: string | null;
  confidence: number;
  method: string;
  candidates: MatchCandidate[];
};

const EXACT_METHOD = "domain_exact";
const ALIAS_METHOD = "alias";
const EXACT_UNSCOPED_METHOD = "exact";
const TRIGRAM_METHOD = "trigram";
const EMBEDDING_METHOD = "embedding";
const ADJUDICATION_METHOD = "adjudication";

function domainOf(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  return at === -1 ? null : email.slice(at + 1).toLowerCase();
}

async function domainPriorMatch(
  supabase: SupabaseClient,
  text: string,
  entityType: MatchEntityType,
  senderDomain: string | null
): Promise<MatchResult | null> {
  if (entityType !== "item" || !senderDomain) return null;

  const { data: items, error } = await supabase
    .from("items")
    .select("id,name,supplier_email")
    .is("deleted_at", null)
    .not("supplier_email", "is", null);
  if (error || !items) return null;

  const supplierItems = items.filter((i) => domainOf(i.supplier_email) === senderDomain);
  if (supplierItems.length === 0) return null;

  const normalized = text.trim().toLowerCase();
  const exact = supplierItems.find((i) => i.name.trim().toLowerCase() === normalized);
  if (!exact) return null;

  return { entityId: exact.id, confidence: 0.95, method: EXACT_METHOD, candidates: [{ entity_id: exact.id, name: exact.name, score: 1 }] };
}

async function aliasOrExactMatch(
  supabase: SupabaseClient,
  text: string,
  entityType: MatchEntityType
): Promise<MatchResult | null> {
  const normalized = text.trim().toLowerCase();

  const { data: alias } = await supabase
    .from("entity_aliases")
    .select("entity_id")
    .eq("entity_type", entityType)
    .ilike("alias", normalized)
    .maybeSingle();
  if (alias) {
    const table = entityType === "item" ? "items" : "projects";
    const { data: entity } = await supabase.from(table).select("id,name").eq("id", alias.entity_id).maybeSingle();
    if (entity) {
      return {
        entityId: entity.id,
        confidence: 0.97,
        method: ALIAS_METHOD,
        candidates: [{ entity_id: entity.id, name: entity.name, score: 1 }],
      };
    }
  }

  const table = entityType === "item" ? "items" : "projects";
  const { data: exactMatches } = await supabase.from(table).select("id,name").is("deleted_at", null).ilike("name", normalized);
  if (exactMatches && exactMatches.length === 1) {
    return {
      entityId: exactMatches[0].id,
      confidence: 0.95,
      method: EXACT_UNSCOPED_METHOD,
      candidates: [{ entity_id: exactMatches[0].id, name: exactMatches[0].name, score: 1 }],
    };
  }

  return null;
}

async function trigramCandidates(supabase: SupabaseClient, text: string, entityType: MatchEntityType): Promise<MatchCandidate[]> {
  const { data, error } = await supabase.rpc("trigram_match", {
    query_text: text,
    p_entity_type: entityType,
    p_threshold: 0.55,
    p_limit: 5,
  });
  if (error || !data) return [];
  return (data as { entity_id: string; name: string; similarity: number }[]).map((r) => ({
    entity_id: r.entity_id,
    name: r.name,
    score: r.similarity,
  }));
}

async function embeddingCandidates(
  supabase: SupabaseClient,
  text: string,
  entityType: MatchEntityType,
  embedText: (text: string) => Promise<number[]>
): Promise<MatchCandidate[]> {
  const embedding = await embedText(text);
  const { data, error } = await supabase.rpc("hybrid_search", {
    query_text: text,
    query_embedding: `[${embedding.join(",")}]`,
    match_count: 5,
    filter_type: entityType,
  });
  if (error || !data) return [];
  return (data as { entity_id: string; title: string; score: number }[]).map((r) => ({
    entity_id: r.entity_id,
    name: r.title,
    score: r.score,
  }));
}

function mergeCandidates(a: MatchCandidate[], b: MatchCandidate[]): MatchCandidate[] {
  const byId = new Map<string, MatchCandidate>();
  for (const c of [...a, ...b]) {
    const existing = byId.get(c.entity_id);
    if (!existing || c.score > existing.score) byId.set(c.entity_id, c);
  }
  return [...byId.values()].sort((x, y) => y.score - x.score);
}

const ADJUDICATION_TOOL: ClaudeTool = {
  name: "adjudicate_match",
  description: "Decide which candidate (if any) the mention text refers to.",
  input_schema: {
    type: "object",
    properties: {
      entity_id: { type: ["string", "null"], description: "The matching candidate's entity_id, or null if none genuinely match" },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: ["entity_id", "confidence"],
    additionalProperties: false,
  },
};

async function adjudicate(text: string, entityType: MatchEntityType, candidates: MatchCandidate[]): Promise<MatchResult> {
  const candidateList = candidates.map((c) => `- id=${c.entity_id}: "${c.name}" (similarity score ${c.score.toFixed(3)})`).join("\n");
  const { toolInput } = await callClaude({
    model: "claude-sonnet-5",
    system: `You are adjudicating an entity match for RESLU, an interior design studio. Given a free-text mention extracted from a supplier/client email, and a short list of candidate ${entityType === "item" ? "spec-register items" : "projects"} that a similarity search found, decide which candidate (if any) the mention genuinely refers to. Only pick a candidate if you are reasonably confident it is the same real-world thing the mention is talking about — if the mention is too vague, generic, or none of the candidates plausibly match, return entity_id: null. Call adjudicate_match exactly once.`,
    messages: [{ role: "user", content: `Mention text: "${text}"\n\nCandidates:\n${candidateList}` }],
    tool: ADJUDICATION_TOOL,
    maxTokens: 256,
  });
  const parsed = toolInput as { entity_id: string | null; confidence: number };
  return { entityId: parsed.entity_id, confidence: parsed.confidence, method: ADJUDICATION_METHOD, candidates };
}

export async function matchMention(
  supabase: SupabaseClient,
  params: { text: string; entityType: MatchEntityType; senderDomain: string | null; embedText: (text: string) => Promise<number[]> }
): Promise<MatchResult> {
  const { text, entityType, senderDomain, embedText } = params;

  const domainResult = await domainPriorMatch(supabase, text, entityType, senderDomain);
  if (domainResult) return domainResult;

  const aliasResult = await aliasOrExactMatch(supabase, text, entityType);
  if (aliasResult) return aliasResult;

  const [trigram, embedding] = await Promise.all([
    trigramCandidates(supabase, text, entityType),
    embeddingCandidates(supabase, text, entityType, embedText),
  ]);
  const combined = mergeCandidates(trigram, embedding);

  if (combined.length === 0) {
    return { entityId: null, confidence: 0, method: "no_candidates", candidates: [] };
  }

  if (combined.length === 1) {
    return { entityId: combined[0].entity_id, confidence: combined[0].score, method: TRIGRAM_METHOD, candidates: combined };
  }

  // Clear single winner: top score meaningfully ahead of the runner-up.
  if (combined[0].score - combined[1].score >= 0.15) {
    return { entityId: combined[0].entity_id, confidence: combined[0].score, method: EMBEDDING_METHOD, candidates: combined };
  }

  return adjudicate(text, entityType, combined);
}
