import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { FALLBACK_PHASE_TEMPLATE } from "@/lib/phase-template";
import type { AppSettingsPhaseTemplateRow, PutPhaseTemplateInput } from "@/types/phase-fix-a";

const VALID_KINDS = new Set(["phase", "umbrella"]);

/**
 * GET /api/settings/phase-template
 * Team-visible (studio-wide configuration, not financial — same
 * trust tier as GET /api/categories). Response: { template }, read
 * from app_settings('phase_template') (migration 023, seeded at
 * migration time). Falls back to lib/phase-template.ts's
 * FALLBACK_PHASE_TEMPLATE (kept byte-for-byte identical to the
 * migration's seed literal) in the defensive case the row is
 * somehow missing — this should never actually trigger, since the
 * migration seeds it unconditionally.
 *
 * BUILD-SPEC.md "Pre-populated phases": "template stored in
 * app_settings key 'phase_template', editable via a simple list
 * editor in the Settings page." This route + PUT below back that
 * editor (components/settings/PhaseTemplateSettings.tsx). The seed
 * consumers themselves (lib/phase-seed.ts's seedPhaseTemplateIfEmpty)
 * read app_settings directly, not through this route — this route
 * exists purely for the Settings UI to read/write the editable copy.
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
    .eq("key", "phase_template")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const template = (data?.value as AppSettingsPhaseTemplateRow[] | undefined) ?? FALLBACK_PHASE_TEMPLATE;
  return NextResponse.json({ template });
}

/**
 * PUT /api/settings/phase-template
 * Admin-only (mirrors PATCH /api/categories/[id]'s admin gating —
 * this is studio-wide configuration, not per-project data). Body:
 * PutPhaseTemplateInput — { template: [{ name, kind }] } — full
 * replace (upsert onto the single app_settings row). Validates:
 * non-empty array, every row has a non-empty trimmed name and
 * kind in ('phase','umbrella'), and EXACTLY ONE row is kind='umbrella'
 * — the seed path (lib/phase-seed.ts) assumes a single umbrella row
 * per project when it applies this template, so a template with zero
 * or multiple umbrella rows would silently break that assumption for
 * every project seeded after the edit.
 *
 * Does NOT retroactively touch any already-seeded project's
 * schedule_phases — this only changes what NEW projects (or projects
 * that haven't had their Timeline/Board visited yet) get seeded with,
 * per BUILD-SPEC.md's "seed on first visit" model.
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can edit the phase template" },
      { status: 403 }
    );
  }

  let body: PutPhaseTemplateInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!Array.isArray(body.template) || body.template.length === 0) {
    return NextResponse.json({ error: "template must be a non-empty array" }, { status: 400 });
  }

  const cleaned: AppSettingsPhaseTemplateRow[] = [];
  for (const row of body.template) {
    const name = typeof row?.name === "string" ? row.name.trim() : "";
    const kind = row?.kind;
    if (!name) {
      return NextResponse.json({ error: "Every phase needs a name" }, { status: 400 });
    }
    if (!VALID_KINDS.has(kind)) {
      return NextResponse.json({ error: "kind must be 'phase' or 'umbrella'" }, { status: 400 });
    }
    cleaned.push({ name, kind });
  }

  const umbrellaCount = cleaned.filter((r) => r.kind === "umbrella").length;
  if (umbrellaCount !== 1) {
    return NextResponse.json(
      { error: "Exactly one phase must be kind 'umbrella' (e.g. Site Setup)" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "phase_template", value: cleaned, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ template: cleaned });
}
