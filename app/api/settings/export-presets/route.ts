import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { cleanPresetRow, resolveExportPresets } from "@/lib/export-presets";
import type { ExportPresetRow, PutExportPresetsInput } from "@/types/round-export-batch";

/**
 * GET /api/settings/export-presets
 * Team-visible (studio-wide configuration, not financial — same trust
 * tier as GET /api/settings/phase-template). Response: { presets },
 * read from app_settings('export_presets'). No migration for this
 * round (BUILD-SPEC.md "Export + board batch" item 1: "app_settings
 * carries presets") — falls back to lib/export-presets.ts's
 * FALLBACK_EXPORT_PRESETS (Plumber -> TW+SW, Electrician -> LI+EL)
 * when the row has never been written, same "code fallback, not a
 * migration seed" pattern as FALLBACK_PHASE_TEMPLATE.
 */
export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "export_presets")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const presets = resolveExportPresets(data?.value);
  return NextResponse.json({ presets });
}

/**
 * PUT /api/settings/export-presets
 * Admin-only (mirrors PUT /api/settings/phase-template's exact
 * gating — studio-wide configuration, not per-project data). Body:
 * PutExportPresetsInput — { presets: [{ name, prefixes[] }] } — full
 * replace (upsert onto the single app_settings row). Every row needs
 * a non-empty trimmed name; prefixes are optional (an empty array is a
 * pure trade tag with no export/order-by mapping — see
 * lib/export-presets.ts's cleanPresetRow comment), upper-cased and
 * de-duped when present so "tw" and "TW" in the editor never produce
 * two silently-different category filters.
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can edit export presets" },
      { status: 403 }
    );
  }

  let body: PutExportPresetsInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.presets)) {
    return NextResponse.json({ error: "presets must be an array" }, { status: 400 });
  }

  const cleaned: ExportPresetRow[] = [];
  for (const row of body.presets) {
    const clean = cleanPresetRow(row);
    if (!clean) {
      return NextResponse.json(
        { error: "Every preset needs a name" },
        { status: 400 }
      );
    }
    cleaned.push(clean);
  }

  const resolved = resolveExportPresets(cleaned);
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "export_presets", value: resolved, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presets: resolved });
}
