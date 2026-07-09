// ============================================================
// RESLU Spec System — "Trade-scoped SOW extracts" round LOCAL types
// (8 July 2026). supabase/migrations/044_sow_trade_tags.sql's
// sow_lines.trade column, lib/sow-trade-tags.ts, components/sow/
// SowBuilder.tsx's trade select + "Suggest trade tags" action,
// the extract PDF routes, and the trade-doc-pack integration.
//
// Deliberately NOT added to types/index.ts (protected — see this
// round's own file-boundary list) — follows the exact same per-round-
// own-file convention every phase-N.ts / round-*.ts file in this
// directory already uses (see types/phase-12a-a.ts's header comment
// for the fullest statement of the rationale: types/index.ts is a
// shared file other concurrent work may also be touching, so an
// additive round adds its own small file instead of widening it).
//
// Cross-imports from types/index.ts are READ-ONLY reuse of existing,
// already-defined shapes — nothing in that file is modified. SowLine/
// SowSectionWithLines predate this round's `trade` column, so this
// file's job is exactly the small, mechanical extension: everywhere
// this round's own files touch a SOW line, they use
// `SowLineWithTrade`/`SowSectionWithTradedLines` instead of the bare
// types/index.ts shapes, which lack the new column. Both extend (not
// replace) the shared shapes, so an array of the wider type is always
// structurally assignable wherever the narrower shared type is
// expected (e.g. passing sections straight into components/pdf/
// SowPdf.tsx, whose own `sections` prop is still typed
// `SowSectionWithLines[]`).
// ============================================================

import type { SowLine, SowLineKind, SowSectionWithLines } from "@/types";

/** A sow_lines row including this round's additive `trade` column. */
export type SowLineWithTrade = SowLine & { trade: string | null };

/** A sow_sections row with `trade`-bearing lines nested. */
export interface SowSectionWithTradedLines extends Omit<SowSectionWithLines, "lines"> {
  lines: SowLineWithTrade[];
}

/** body accepted by PATCH /api/sow/lines/[lineId] as of this round — the ONE field added to that route's existing partial-update body. */
export interface PatchSowLineTradeInput {
  text?: string;
  kind?: SowLineKind;
  sort?: number;
  /** Explicit `null` clears the tag; `undefined`/absent leaves it unchanged — same "only touch what's present" convention as the route's existing text/kind/sort handling. */
  trade?: string | null;
}

/** response shape for POST /api/projects/[id]/sow/[sowId]/suggest-trade-tags. */
export interface SuggestTradeTagsResponse {
  /** Every line that was ACTUALLY updated by this run (previously untagged, a suggestion matched) — the builder merges these into its local section state without a full reload. */
  lines: SowLineWithTrade[];
  tagged_count: number;
}
