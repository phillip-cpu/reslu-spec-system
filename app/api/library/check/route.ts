import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeProductUrl } from "@/lib/scraper";
import type { CheckDuplicatesResponse, DuplicateMatch } from "@/types";

/**
 * GET /api/library/check?url=...
 *
 * Duplicate detection (BUILD-SPEC.md "Library — trade price capture &
 * duplicate detection"): normalises the given URL the same way it's
 * stored on create/update (lib/scraper/normalize.ts) and checks for an
 * exact match against product_url_normalized in both library_items and
 * active (non-deleted) items across all projects. Non-blocking by
 * design — this is an informational lookup the UI shows as a warning,
 * never a hard block on item creation.
 *
 * No financial fields are selected here (name/item_code/category only)
 * — this endpoint is reachable by any authenticated team member, not
 * just admins, and must not leak price data.
 */
export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rawUrl = request.nextUrl.searchParams.get("url");
  const normalized = normalizeProductUrl(rawUrl);
  if (!normalized) {
    return NextResponse.json({ duplicates: [] } satisfies CheckDuplicatesResponse);
  }

  const duplicates: DuplicateMatch[] = [];

  const [libraryResult, itemResult] = await Promise.all([
    supabase
      .from("library_items")
      .select("id, name")
      .eq("product_url_normalized", normalized)
      .limit(5),
    supabase
      .from("items")
      .select("id, name, item_code")
      .eq("product_url_normalized", normalized)
      .is("deleted_at", null)
      .limit(5),
  ]);

  for (const row of libraryResult.data ?? []) {
    duplicates.push({ source: "library", id: row.id, name: row.name });
  }
  for (const row of itemResult.data ?? []) {
    duplicates.push({
      source: "project",
      id: row.id,
      name: row.name,
      item_code: row.item_code,
    });
  }

  return NextResponse.json({ duplicates } satisfies CheckDuplicatesResponse);
}
