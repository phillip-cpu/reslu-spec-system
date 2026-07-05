// ============================================================
// RESLU Spec System — Estimate versioning + VM comparison
// BUILD-SPEC.md "Phase 12a — My Work + estimate versioning with VM":
// "cost-reduction revisions using cheaper materials or removing scope
// ... VM comparison view — the deliverable: side-by-side any version
// vs current (or vs another version): per-section deltas,
// changed/removed/added lines highlighted, substituted FF&E items (was
// X -> now Y, saving $Z), headline 'Total saving: $N ex GST'."
//
// Pure, dependency-free helpers used by both
// app/api/projects/[id]/versions/** (snapshot build + compare) and
// components/estimate/VersionCompare.tsx (client-side re-render of an
// already-fetched compare payload needs none of this — the API does
// the diffing server-side so the comparison logic can never drift
// between two admin sessions looking at the same pair of versions).
// Mirrors lib/estimate.ts / lib/sow.ts's existing "pure module, no
// Supabase/Next imports" convention.
// ============================================================

import { lineCost, roundMoney } from "./estimate";
import type { CostLine, CostSectionWithLines } from "@/types";
import type {
  EstimateSnapshot,
  FfeSubstitution,
  LineDiffEntry,
  SectionDiffEntry,
} from "@/types/phase-12a-a";

/**
 * Suggests the next version label given existing labels for a project —
 * NOT enforced (estimate_versions.label has no auto-numbering, per the
 * migration's comment: "free text, team-chosen"). Looks for the
 * highest bare "V<n>" among existing labels and offers "V<n+1>"; if the
 * caller is starting a VM revision off that, "VM_V<n+1>" is offered
 * for the same number instead. Falls back to "V1" for a project with no
 * versions yet.
 */
export function suggestNextLabel(existingLabels: string[], kind: "issue" | "vm" = "issue"): string {
  let maxN = 0;
  for (const label of existingLabels) {
    const match = /^(?:VM_)?V(\d+)$/i.exec(label.trim());
    if (match) maxN = Math.max(maxN, Number(match[1]));
  }
  const n = maxN + 1;
  return kind === "vm" ? `VM_V${n}` : `V${n}`;
}

// ------------------------------------------------------------
// Section/line diffing
// ------------------------------------------------------------

/**
 * Matches lines between two snapshots' sections by id when the line
 * survived between versions unchanged in identity, else falls back to
 * matching by description text within the same section (covers the
 * common VM case: a line was edited in place, e.g. rate dropped for a
 * cheaper material — same row id, so id-matching already covers it;
 * description-matching only matters if a line was deleted and a new
 * one created to replace it, which the "added"+"removed" pair already
 * represents correctly without any matching at all). Sections are
 * matched by name (case-sensitive exact) since cost_sections don't
 * carry a stable cross-version id once a version is a frozen snapshot
 * — a section renamed between two versions shows as one section
 * "removed" (from A) and a different one "added" (in B), which is the
 * honest/correct diff outcome for a rename the diff has no way to
 * distinguish from a genuine remove+add.
 */
export function diffSections(
  aSections: CostSectionWithLines[],
  bSections: CostSectionWithLines[]
): SectionDiffEntry[] {
  const bByName = new Map(bSections.map((s) => [s.name, s]));
  const seenNames = new Set<string>();
  const result: SectionDiffEntry[] = [];

  for (const aSection of aSections) {
    seenNames.add(aSection.name);
    const bSection = bByName.get(aSection.name);
    const lines = diffLines(aSection.lines, bSection?.lines ?? []);
    const sectionDelta = roundMoney(
      lines.reduce((sum, l) => sum + (l.costDelta ?? 0), 0)
    );
    if (lines.length > 0) {
      result.push({ name: aSection.name, lines, sectionDelta });
    }
  }

  // Sections that exist only in B (added sections, e.g. a new trade
  // scope introduced in a later version) — every one of their lines is
  // "added".
  for (const bSection of bSections) {
    if (seenNames.has(bSection.name)) continue;
    const lines = diffLines([], bSection.lines);
    const sectionDelta = roundMoney(lines.reduce((sum, l) => sum + (l.costDelta ?? 0), 0));
    if (lines.length > 0) {
      result.push({ name: bSection.name, lines, sectionDelta });
    }
  }

  return result;
}

/** Line-level diff within one section — matched by id, then by description for anything id-matching missed. */
function diffLines(aLines: CostLine[], bLines: CostLine[]): LineDiffEntry[] {
  const bById = new Map(bLines.map((l) => [l.id, l]));
  const bByDescription = new Map(bLines.map((l) => [l.description.trim().toLowerCase(), l]));
  const matchedBIds = new Set<string>();
  const entries: LineDiffEntry[] = [];

  for (const a of aLines) {
    const b = bById.get(a.id) ?? bByDescription.get(a.description.trim().toLowerCase());
    if (b) {
      matchedBIds.add(b.id);
      const costDelta = computeCostDelta(a, b);
      const changed = !linesEqual(a, b);
      entries.push({
        status: changed ? "changed" : "unchanged",
        line: b,
        previous: a,
        costDelta: changed ? costDelta : 0,
      });
    } else {
      const aCost = lineCost(a);
      entries.push({
        status: "removed",
        line: null,
        previous: a,
        costDelta: aCost !== null ? roundMoney(-aCost) : null,
      });
    }
  }

  for (const b of bLines) {
    if (matchedBIds.has(b.id)) continue;
    // Not matched by id and not matched by description to any A line
    // (description-matched ones were already consumed above via
    // bByDescription lookup keyed from the A side — a B line whose
    // description matches an A line's is only "added" here if that A
    // line was ALSO matched to a different B line first, which can't
    // happen since each A line only matches one B line and matchedBIds
    // already excludes it).
    const bCost = lineCost(b);
    entries.push({
      status: "added",
      line: b,
      previous: null,
      costDelta: bCost !== null ? roundMoney(bCost) : null,
    });
  }

  // Only lines that changed, were added, or removed are interesting to
  // show in the comparison view — unchanged lines are omitted from the
  // rendered diff entirely (the caller filters status === "unchanged"
  // for display; kept here so sectionDelta math and "N lines
  // unchanged" counts can still be derived from the full list if
  // needed later).
  return entries;
}

function computeCostDelta(a: CostLine, b: CostLine): number | null {
  const aCost = lineCost(a);
  const bCost = lineCost(b);
  if (aCost === null || bCost === null) return null;
  return roundMoney(bCost - aCost);
}

/** Field-level equality check for the "changed" vs "unchanged" line diff status. */
function linesEqual(a: CostLine, b: CostLine): boolean {
  return (
    a.description === b.description &&
    a.qty === b.qty &&
    a.unit === b.unit &&
    a.rate_ex_gst === b.rate_ex_gst &&
    a.cost_ex_gst === b.cost_ex_gst &&
    a.item_id === b.item_id
  );
}

// ------------------------------------------------------------
// FF&E substitution matching — BUILD-SPEC.md: "substituted FF&E items
// (was X -> now Y, saving $Z)" matched by item_code per the task brief.
// ------------------------------------------------------------

/** Minimal per-item shape needed for FF&E substitution matching — mirrors ffeRollup's FfeItemInput plus name/item_code. */
export interface FfeSubstitutionItemInput {
  item_code: string;
  name: string;
  quantity: number;
  price_trade: number | null;
  price_rrp: number | null;
}

function bestFfeTotal(item: FfeSubstitutionItemInput): number {
  const price = item.price_trade ?? item.price_rrp;
  return price !== null && price !== undefined ? roundMoney(item.quantity * price) : 0;
}

/**
 * Matches FF&E items between two snapshots by item_code and reports
 * any where the item itself changed (different name — a genuine
 * product substitution) or the line total changed materially (price/
 * qty change on the SAME product, e.g. a VM re-quote) — both count as
 * a "substitution" row per the build spec's "was X -> now Y" framing
 * (X and Y can be the same product name at a different price when it's
 * a re-quote rather than a different SKU).
 */
export function diffFfeSubstitutions(
  aItems: FfeSubstitutionItemInput[],
  bItems: FfeSubstitutionItemInput[]
): FfeSubstitution[] {
  const aByCode = new Map(aItems.map((i) => [i.item_code, i]));
  const bByCode = new Map(bItems.map((i) => [i.item_code, i]));
  const codes = new Set([...aByCode.keys(), ...bByCode.keys()]);
  const result: FfeSubstitution[] = [];

  for (const code of codes) {
    const a = aByCode.get(code) ?? null;
    const b = bByCode.get(code) ?? null;
    const aTotal = a ? bestFfeTotal(a) : 0;
    const bTotal = b ? bestFfeTotal(b) : 0;
    const nameChanged = a && b && a.name !== b.name;
    const totalChanged = roundMoney(aTotal - bTotal) !== 0;
    if (!a || !b || nameChanged || totalChanged) {
      result.push({
        item_code: code,
        was: a ? { name: a.name, total: aTotal } : null,
        now: b ? { name: b.name, total: bTotal } : null,
        saving: roundMoney(aTotal - bTotal),
      });
    }
  }

  // Largest saving first — the headline rows Phillip actually cares
  // about surface at the top of the substitutions table.
  result.sort((x, y) => y.saving - x.saving);
  return result;
}

// ------------------------------------------------------------
// Headline totals
// ------------------------------------------------------------

/** a.wholeJob.combinedExGst - b.wholeJob.combinedExGst — positive means B (the "now"/current side) is cheaper, i.e. a real saving. */
export function totalSaving(a: EstimateSnapshot, b: EstimateSnapshot): number {
  return roundMoney(a.wholeJob.combinedExGst - b.wholeJob.combinedExGst);
}
