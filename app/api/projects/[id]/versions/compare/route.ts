import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  diffFfeSubstitutions,
  diffSections,
  ffeSubstitutionItemsFromSnapshot,
  totalSaving,
} from "@/lib/estimate-versions";
import { buildLiveSnapshot } from "@/lib/estimate-live-snapshot";
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

  // Every newly saved version (and the in-memory Current side) carries frozen
  // item identities. Older versions retain honest category totals but not the
  // detail required for an item-level comparison; report that limitation
  // instead of incorrectly showing every live item as newly added.
  const aItems = ffeSubstitutionItemsFromSnapshot(a.snapshot);
  const bItems = ffeSubstitutionItemsFromSnapshot(b.snapshot);
  const ffeComparisonAvailable = aItems !== null && bItems !== null;
  const ffeSubstitutions = ffeComparisonAvailable
    ? diffFfeSubstitutions(aItems, bItems)
    : [];

  const payload: VersionCompareResponse = {
    a: { label: a.label, created_at: a.created_at },
    b: { label: b.label, created_at: b.created_at },
    sections,
    ffeSubstitutions,
    ffeComparisonAvailable,
    totalSavingExGst: totalSaving(a.snapshot, b.snapshot),
    totalA: a.snapshot.wholeJob.combinedExGst,
    totalB: b.snapshot.wholeJob.combinedExGst,
  };

  return NextResponse.json(payload);
}
