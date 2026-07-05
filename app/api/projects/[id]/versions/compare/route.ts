import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { diffFfeSubstitutions, diffSections, totalSaving } from "@/lib/estimate-versions";
import type { FfeSubstitutionItemInput } from "@/lib/estimate-versions";
import { buildLiveSnapshot } from "../route";
import type { EstimateSnapshot, VersionCompareResponse } from "@/types/phase-12a-a";

/**
 * GET /api/projects/[id]/versions/compare?a=<versionId|current>&b=<versionId|current>
 * The VM comparison view's data source — BUILD-SPEC.md "VM comparison
 * view — the deliverable: side-by-side any version vs current (or vs
 * another version): per-section deltas, changed/removed/added lines
 * highlighted, substituted FF&E items (was X -> now Y, saving $Z),
 * headline 'Total saving: $N ex GST'."
 *
 * `a`/`b` are each either an estimate_versions.id or the literal string
 * "current" (the project's live, unfrozen estimate state, built
 * on-the-fly via buildLiveSnapshot() — never persisted). Diff direction
 * is always A -> B ("was" = A, "now" = B); the UI picks which side is
 * which. Admin-only, financial.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access estimate versions" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const aParam = searchParams.get("a");
  const bParam = searchParams.get("b");
  if (!aParam || !bParam) {
    return NextResponse.json({ error: "Both a and b query params are required" }, { status: 400 });
  }

  async function resolveSide(
    param: string
  ): Promise<{ label: string; created_at: string | null; snapshot: EstimateSnapshot } | { error: string; status: number }> {
    if (param === "current") {
      const snapshot = await buildLiveSnapshot(supabase, projectId);
      if ("error" in snapshot) return snapshot;
      return { label: "Current", created_at: null, snapshot };
    }
    const { data, error } = await supabase
      .from("estimate_versions")
      .select("label, created_at, snapshot")
      .eq("id", param)
      .eq("project_id", projectId)
      .single();
    if (error || !data) {
      return { error: `Version not found: ${param}`, status: 404 };
    }
    return { label: data.label, created_at: data.created_at, snapshot: data.snapshot as EstimateSnapshot };
  }

  const [a, b] = await Promise.all([resolveSide(aParam), resolveSide(bParam)]);
  if ("error" in a) return NextResponse.json({ error: a.error }, { status: a.status });
  if ("error" in b) return NextResponse.json({ error: b.error }, { status: b.status });

  const sections = diffSections(a.snapshot.sections, b.snapshot.sections);

  // FF&E substitution matching needs item name/code/qty/price, not just
  // the ffe rollup totals — pull items fresh, mapped by category isn't
  // enough (item_code lives on `items`, not on the ffe rollup's
  // category-grouped shape) so a small dedicated query is used here
  // rather than trying to reconstruct per-item data from either
  // snapshot's `ffe` block, which is already aggregated by category.
  const [{ data: aItemsRaw }, { data: bItemsRaw }] = await Promise.all([
    aParam === "current"
      ? supabase
          .from("items")
          .select("item_code, name, quantity, price_trade, price_rrp")
          .eq("project_id", projectId)
          .is("deleted_at", null)
      : Promise.resolve({ data: null }),
    bParam === "current"
      ? supabase
          .from("items")
          .select("item_code, name, quantity, price_trade, price_rrp")
          .eq("project_id", projectId)
          .is("deleted_at", null)
      : Promise.resolve({ data: null }),
  ]);

  // Frozen versions don't store per-item FF&E detail in the snapshot
  // (only the aggregated ffe rollup) — substitution matching against a
  // frozen version's FF&E is therefore only meaningful when at least
  // one side is "current" (the only side with live item rows
  // available). Both-frozen comparisons still get the section/line
  // diff and headline saving; ffeSubstitutions is empty in that case
  // (documented in docs/API.md) rather than silently wrong.
  const aItems: FfeSubstitutionItemInput[] = (aItemsRaw ?? []).map((i) => ({
    item_code: i.item_code,
    name: i.name,
    quantity: i.quantity,
    price_trade: i.price_trade,
    price_rrp: i.price_rrp,
  }));
  const bItems: FfeSubstitutionItemInput[] = (bItemsRaw ?? []).map((i) => ({
    item_code: i.item_code,
    name: i.name,
    quantity: i.quantity,
    price_trade: i.price_trade,
    price_rrp: i.price_rrp,
  }));
  const ffeSubstitutions =
    aParam === "current" || bParam === "current" ? diffFfeSubstitutions(aItems, bItems) : [];

  const payload: VersionCompareResponse = {
    a: { label: a.label, created_at: a.created_at },
    b: { label: b.label, created_at: b.created_at },
    sections,
    ffeSubstitutions,
    totalSavingExGst: totalSaving(a.snapshot, b.snapshot),
    totalA: a.snapshot.wholeJob.combinedExGst,
    totalB: b.snapshot.wholeJob.combinedExGst,
  };

  return NextResponse.json(payload);
}
