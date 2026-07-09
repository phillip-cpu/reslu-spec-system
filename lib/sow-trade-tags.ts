// ============================================================
// RESLU Spec System — "Trade-scoped SOW extracts" round.
// BUILD-SPEC.md "Trade-scoped SOW extracts": "'Select all carpentry' ->
// condensed scope per trade." This file is the pure domain layer for
// two related concerns, kept together because they share the same
// vocabulary (a SOW line's `trade` tag, matched against
// app_settings('export_presets') preset NAMES — see
// supabase/migrations/044_sow_trade_tags.sql's own comment for why
// `trade` is free text, not a constrained lookup):
//
//   1. AUTO-SUGGEST — a keyword table mapping a room section's
//      clause-label prefixes (lib/sow-templates.ts's roomSectionTemplate()
//      lines, e.g. "WALL TILING — {{...}}") to a trade name, used both
//      by "Start from template" (tags room-section lines the moment
//      they're created) and the builder's one-click "Suggest trade
//      tags" action (fills only currently-untagged lines on an
//      existing SOW).
//
//   2. EXTRACT COMPOSITION — the rule for which sections/lines survive
//      into a trade-scoped extract PDF, shared by both PDF routes
//      (GET /api/projects/[id]/sow/[sowId]/pdf and
//      GET /api/trade/[token]/documents/sow) so the team-facing and
//      trade-facing extracts can never drift on what "Carpenter scope"
//      actually means.
//
// Dependency-free (no Supabase/Next imports) — same convention as
// lib/sow.ts / lib/sow-templates.ts / lib/export-presets.ts.
// ============================================================

import type { SowLineWithTrade, SowSectionWithTradedLines } from "@/types/sow-trade-tags";

// ------------------------------------------------------------
// 1. Auto-suggest — clause-label keyword table
// ------------------------------------------------------------

/**
 * One row of the keyword table: any of `keywords` found (case-
 * insensitive substring) in a line's CLAUSE LABEL (see
 * extractClauseLabel() below — NOT the line's full free-text body,
 * which deliberately avoids false-positive matches against unrelated
 * prose — see that function's own doc comment) suggests `trade`.
 *
 * Table content is the exact mapping given for this round: WALL
 * TILING / FLOOR FINISHES / WATERPROOFING -> Tiler; JOINERY ->
 * Carpenter; SANITARYWARE / TAPWARE -> Plumber; ELECTRICAL / LIGHTING
 * -> Electrician; PAINTING -> Painter; PARTITIONS / PLASTER ->
 * Plasterer; DEMOLISH -> Demolition; SHOWER SCREEN -> Glazier; STONE
 * -> Stonemason. Order matters only in the sense that the FIRST
 * matching rule wins — none of these keyword sets overlap in
 * practice (each clause label in lib/sow-templates.ts's
 * roomSectionTemplate() carries exactly one of these prefixes), so in
 * practice at most one rule ever matches a given label.
 */
export interface TradeKeywordRule {
  keywords: string[];
  trade: string;
}

export const TRADE_KEYWORD_TABLE: TradeKeywordRule[] = [
  { keywords: ["WALL TILING", "FLOOR FINISHES", "WATERPROOFING"], trade: "Tiler" },
  { keywords: ["JOINERY"], trade: "Carpenter" },
  { keywords: ["SANITARYWARE", "TAPWARE"], trade: "Plumber" },
  { keywords: ["ELECTRICAL", "LIGHTING"], trade: "Electrician" },
  { keywords: ["PAINTING"], trade: "Painter" },
  { keywords: ["PARTITIONS", "PLASTER"], trade: "Plasterer" },
  { keywords: ["DEMOLISH"], trade: "Demolition" },
  { keywords: ["SHOWER SCREEN"], trade: "Glazier" },
  { keywords: ["STONE"], trade: "Stonemason" },
];

/**
 * Extracts a line's leading CLAUSE LABEL — the short, all-caps prefix
 * before an em-dash/hyphen/colon separator that every room-section
 * sub-clause in lib/sow-templates.ts's roomSectionTemplate() is
 * written with, e.g. "WALL TILING — {{tile product code(s)...}}" ->
 * "WALL TILING", "DEMOLISH — full strip-out..." -> "DEMOLISH".
 *
 * Deliberately a PREFIX match, not "does this keyword appear anywhere
 * in the line's text" — a General Notes clause like "Waterproofing to
 * all wet areas per AS 3740-2010..." contains the word "Waterproofing"
 * too, but is a full sentence, not a "WATERPROOFING — ..." labelled
 * clause, so a naive substring-anywhere match would incorrectly
 * suggest Tiler for a General Notes / Compliance line that has nothing
 * to do with a specific trade's scope. Requiring the label to be the
 * line's own leading run of capitals followed immediately by a
 * separator is what keeps the heuristic scoped to the room sub-clause
 * pattern it was designed for, per BUILD-SPEC.md's own example ("the
 * room sub-clause labels like 'WALL TILING —'").
 *
 * Returns null when the line has no such prefix (every General Notes /
 * Project Overview / Site Management / Exclusions clause in this
 * codebase's template library, and any hand-typed line that isn't
 * written in the "LABEL — text" convention) — those lines are simply
 * never suggested a trade, which is the correct, conservative outcome
 * (an untagged line is omitted from extracts, never mis-tagged).
 */
const CLAUSE_LABEL_PATTERN = /^([A-Z][A-Z0-9 &'/]{1,48}?)\s*(?:—|–|-{1,2}|:)\s+/;

export function extractClauseLabel(text: string): string | null {
  const match = CLAUSE_LABEL_PATTERN.exec(text.trim());
  return match ? match[1].trim() : null;
}

/**
 * Suggests a CANONICAL trade name (e.g. "Tiler") from a line's clause
 * label, per TRADE_KEYWORD_TABLE — before any check against which
 * presets actually exist (see suggestTradeTag() below, the function
 * every caller should actually use). Exported separately for
 * testability/documentation; not itself preset-aware.
 */
export function suggestCanonicalTrade(lineText: string): string | null {
  const label = extractClauseLabel(lineText);
  if (!label) return null;
  const upperLabel = label.toUpperCase();
  for (const rule of TRADE_KEYWORD_TABLE) {
    if (rule.keywords.some((kw) => upperLabel.includes(kw))) return rule.trade;
  }
  return null;
}

/**
 * Resolves a canonical trade name (e.g. "Tiler") against the studio's
 * CURRENT export-preset names, case-insensitively — "only suggest
 * presets that exist" (this round's own instruction): a studio that
 * has never configured a "Tiler" preset gets no suggestion at all for
 * wall-tiling clauses, rather than a tag that doesn't correspond to
 * any real trade chip. Returns the preset's OWN name (preserving
 * whatever casing the studio configured it with — "Tiler" vs
 * "TILER" vs "tiler"), not the canonical table string, so a tagged
 * line's `trade` value always matches a real preset name exactly.
 */
export function resolveAgainstPresets(
  canonicalTrade: string | null,
  presetNames: string[]
): string | null {
  if (!canonicalTrade) return null;
  const match = presetNames.find(
    (name) => name.trim().toLowerCase() === canonicalTrade.trim().toLowerCase()
  );
  return match ?? null;
}

/**
 * The one function callers actually use: suggests a trade tag for a
 * line's text, already resolved against the studio's current preset
 * names — either a real preset name, or null (no suggestion; the line
 * stays untagged). Used by both POST .../from-template (tags room-
 * section lines at creation) and POST .../suggest-trade-tags (the
 * builder's one-click action for existing untagged lines).
 */
export function suggestTradeTag(lineText: string, presetNames: string[]): string | null {
  return resolveAgainstPresets(suggestCanonicalTrade(lineText), presetNames);
}

// ------------------------------------------------------------
// 2. Extract composition — which sections/lines survive a trade filter
// ------------------------------------------------------------

/**
 * A section is a "General Notes" section — per BUILD-SPEC's "General
 * Notes ALWAYS included in full (site conditions/compliance apply to
 * everyone)" — when its heading STARTS WITH "General Notes"
 * (case-insensitive), matching lib/sow-templates.ts's three template
 * headings verbatim ("General Notes — Site Conditions & Protection",
 * "General Notes — Compliance", "General Notes — Drawings &
 * Specifications") as well as any team-renamed variant that keeps the
 * "General Notes" prefix (e.g. a team splitting one of the three into
 * two sections, both still prefixed).
 *
 * CHOSEN OVER a `sort < first-room-section-sort` positional rule
 * (the alternative this round's brief floated) because heading text is
 * robust to section reordering/renumbering (dragging a section, or a
 * future "reorder sections" feature) and to a SOW that was hand-built
 * without ever running "Start from template" at all (no room sections
 * to compare a sort value against) — a text rule keeps working in both
 * cases, a positional rule silently breaks in both.
 */
export function isGeneralNotesHeading(heading: string): boolean {
  return heading.trim().toLowerCase().startsWith("general notes");
}

/**
 * A section is the standard "Exclusions" section — per BUILD-SPEC's
 * "exclusions section always included" — when its heading, trimmed,
 * is EXACTLY "Exclusions" (case-insensitive), matching
 * lib/sow-templates.ts's EXCLUSIONS.heading verbatim. Exact match
 * (not startsWith, unlike General Notes above) since Exclusions is a
 * single section, not a subgrouped family of three — a team section
 * literally titled "Exclusions" is the one this rule is meant to
 * catch; a differently-worded section (e.g. a room's own inline
 * exclusion lines, which live inside that room's own section via
 * `kind: 'exclusion'`, not a separate "Exclusions"-headed section)
 * correctly falls through to the ordinary trade-filter rule below.
 */
export function isExclusionsHeading(heading: string): boolean {
  return heading.trim().toLowerCase() === "exclusions";
}

/**
 * Builds the section list for a trade-scoped extract from a SOW's full
 * section/line set, per BUILD-SPEC.md's exact composition rule:
 *
 *   - General Notes sections (isGeneralNotesHeading) -> included IN
 *     FULL, untouched, regardless of any line's trade tag.
 *   - The Exclusions section (isExclusionsHeading) -> included IN
 *     FULL, untouched, same as General Notes.
 *   - Every other section (Project Overview, Site Management &
 *     Handover, every room section, and any team-added custom section)
 *     -> filtered to only the lines whose `trade` exactly equals
 *     `trade` (untagged lines, and lines tagged for a DIFFERENT trade,
 *     are dropped). A section left with zero lines after this filter
 *     is OMITTED from the extract entirely, not rendered as an empty
 *     heading.
 *
 * `trade` is compared with exact string equality (not case-folded) —
 * `sow_lines.trade` is always written from a real preset name (via
 * suggestTradeTag()'s resolveAgainstPresets() step, or the builder's
 * trade `<select>`, itself populated from the same preset name list),
 * so an exact match is the correct, unambiguous comparison; a
 * case-insensitive fallback would risk two differently-cased presets
 * ("Tiler" vs a hypothetical stray "TILER") silently merging in an
 * extract, which is worse than the (practically nonexistent, since
 * both writers use the same preset list) alternative.
 */
export function filterSectionsForTrade(
  sections: SowSectionWithTradedLines[],
  trade: string
): SowSectionWithTradedLines[] {
  const result: SowSectionWithTradedLines[] = [];
  for (const section of sections) {
    if (isGeneralNotesHeading(section.heading) || isExclusionsHeading(section.heading)) {
      result.push(section);
      continue;
    }
    const filteredLines = section.lines.filter((line) => line.trade === trade);
    if (filteredLines.length === 0) continue;
    result.push({ ...section, lines: filteredLines });
  }
  return result;
}

/**
 * Distinct trade tags actually present across a SOW's lines (any
 * section, any kind), for the builder's "which trade chips do we
 * offer" question — BUILD-SPEC.md's own wording: "trade chips (presets
 * with >=1 tagged line in this SOW)". Callers intersect this against
 * the studio's CURRENT preset name list themselves (this function has
 * no preset awareness — it just reports what's actually tagged), same
 * split as suggestCanonicalTrade()/resolveAgainstPresets() above.
 */
export function distinctTaggedTrades(sections: { lines: { trade: string | null }[] }[]): string[] {
  const set = new Set<string>();
  for (const section of sections) {
    for (const line of section.lines) {
      if (line.trade) set.add(line.trade);
    }
  }
  return [...set];
}

/** True if `line` currently carries no trade tag — the condition "Suggest trade tags" only ever fills. */
export function isUntagged(line: Pick<SowLineWithTrade, "trade">): boolean {
  return line.trade === null || line.trade === undefined;
}
