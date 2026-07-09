import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { FALLBACK_EXPORT_PRESETS } from "@/lib/export-presets";
import { suggestTradeTag } from "@/lib/sow-trade-tags";
import type { SowDocument } from "@/types";
import type { ExportPresetRow } from "@/types/round-export-batch";
import type { SowLineWithTrade, SuggestTradeTagsResponse } from "@/types/sow-trade-tags";

/**
 * POST /api/projects/[id]/sow/[sowId]/suggest-trade-tags
 *
 * "Trade-scoped SOW extracts" round — the builder's one-click "Suggest
 * trade tags" action (BUILD-SPEC.md: "a one-click 'Suggest trade tags'
 * action in the builder for existing SOWs (fills only untagged lines,
 * reports count)"). Companion to the automatic tagging POST
 * .../from-template already does at line-creation time — this route
 * is for content that predates the auto-suggest (an older SOW, or a
 * SOW built by hand without "Start from template") or content that a
 * prior "Start from template" run couldn't tag (no clause-label match,
 * or no matching preset existed yet at the time).
 *
 * Loads every section+line for this SOW, runs lib/sow-trade-tags.ts's
 * suggestTradeTag() against each currently-UNTAGGED line's text
 * (tagged lines — including ones a team member has since retagged to
 * something the heuristic wouldn't have picked — are never touched;
 * this action only ever fills gaps, never overwrites a deliberate
 * choice), and persists every line whose suggestion resolved to a real
 * preset name. Only valid on a DRAFT SOW — same rule "Start from
 * template" already enforces (an issued revision is immutable).
 *
 * Response: SuggestTradeTagsResponse — `{ lines, tagged_count }`, the
 * lines actually updated (for the builder to merge into its local
 * section state without a full reload) and how many were tagged, so
 * the button can report "Tagged 6 lines" (BUILD-SPEC's "reports
 * count") even when that number is zero (nothing matched — not an
 * error, just nothing to do).
 *
 * Team access (not admin-gated — a SOW isn't financial data, same as
 * every other SOW route).
 */
export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; sowId: string }> }
) {
  const { id: projectId, sowId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: sow, error: sowError } = await supabase
    .from("sow_documents")
    .select("*")
    .eq("id", sowId)
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .single();
  if (sowError || !sow) {
    return NextResponse.json({ error: "SOW not found" }, { status: 404 });
  }
  const typedSow = sow as SowDocument;
  if (typedSow.status !== "draft") {
    return NextResponse.json(
      { error: "Only a draft SOW can be re-tagged — issued revisions are read-only." },
      { status: 400 }
    );
  }

  const [{ data: presetsRow }, { data: sections, error: sectionsError }] = await Promise.all([
    supabase.from("app_settings").select("value").eq("key", "export_presets").maybeSingle(),
    supabase.from("sow_sections").select("id, sow_lines(*)").eq("sow_id", sowId),
  ]);
  if (sectionsError) {
    return NextResponse.json({ error: sectionsError.message }, { status: 500 });
  }

  const presets = (presetsRow?.value as ExportPresetRow[] | undefined) ?? FALLBACK_EXPORT_PRESETS;
  const presetNames = presets.map((p) => p.name);

  const untaggedLines: SowLineWithTrade[] = [];
  for (const section of sections ?? []) {
    const lines = (section as unknown as { sow_lines: SowLineWithTrade[] }).sow_lines ?? [];
    for (const line of lines) {
      if (line.trade === null || line.trade === undefined) untaggedLines.push(line);
    }
  }

  const updatedLines: SowLineWithTrade[] = [];
  for (const line of untaggedLines) {
    const suggestion = suggestTradeTag(line.text, presetNames);
    if (!suggestion) continue;
    const { data: updated, error: updateError } = await supabase
      .from("sow_lines")
      .update({ trade: suggestion })
      .eq("id", line.id)
      .select()
      .single();
    if (updateError) {
      return NextResponse.json({ error: updateError.message }, { status: 500 });
    }
    updatedLines.push(updated as SowLineWithTrade);
  }

  const payload: SuggestTradeTagsResponse = {
    lines: updatedLines,
    tagged_count: updatedLines.length,
  };
  return NextResponse.json(payload);
}
