import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { FALLBACK_CPD_DEFAULTS, cleanCpdDefaults } from "@/lib/cpd";
import type { CpdDefaults, CpdDefaultsResponse } from "@/types/cpd";

export const runtime = "nodejs";

/**
 * GET /api/settings/cpd-defaults
 * Team-visible (studio-wide configuration, not financial — same trust
 * tier as GET /api/settings/export-presets/phase-template). Response:
 * { defaults }, read from app_settings('cpd_defaults'), falling back to
 * lib/cpd.ts's FALLBACK_CPD_DEFAULTS (12 points / July start) when the
 * row has never been written — same "code fallback, not a migration
 * seed" pattern as every other app_settings-backed editor.
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
    .eq("key", "cpd_defaults")
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload: CpdDefaultsResponse = {
    defaults: (data?.value as CpdDefaults | undefined) ?? FALLBACK_CPD_DEFAULTS,
  };
  return NextResponse.json(payload);
}

/**
 * PUT /api/settings/cpd-defaults
 * Admin-only (mirrors PUT /api/settings/export-presets's exact gating —
 * studio-wide configuration, not per-project data; unlike bank-details,
 * this is NOT financial, but changing everyone's annual target/licence-
 * year start is still a studio-policy decision, not a per-team-member
 * one). body: { annual_target, year_start_month } — see lib/cpd.ts
 * cleanCpdDefaults() for validation (annual_target > 0,
 * year_start_month a whole number 1-12).
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit CPD defaults" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const cleaned = cleanCpdDefaults(body);
  if (!cleaned) {
    return NextResponse.json(
      { error: "annual_target (a positive number) and year_start_month (1-12) are both required" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: "cpd_defaults", value: cleaned, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const payload: CpdDefaultsResponse = { defaults: cleaned };
  return NextResponse.json(payload);
}
