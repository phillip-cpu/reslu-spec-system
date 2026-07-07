import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type {
  PhaseTaskTemplateRow,
  PhaseTaskTemplatesMap,
  PutPhaseTaskTemplatesInput,
} from "@/types/board-cockpit";
import { FALLBACK_PHASE_TASK_TEMPLATES } from "@/lib/phase-template";

const VALID_KINDS = new Set(["task", "milestone"]);

/**
 * GET /api/settings/phase-task-templates
 * Board cockpit round (7 July 2026) — "phase task templates via
 * app_settings 'phase_task_templates' seeded on phase seed." Team-
 * visible (studio-wide configuration, not financial — same trust tier
 * as GET /api/settings/phase-template, its sibling key on the same
 * app_settings table). Response: { templates } — an object keyed by
 * phase-template NAME (see migration 029's PART 2 comment for why
 * name, not an id) -> array of { title, kind }. Falls back to the real
 * 13-stage checklist (lib/phase-template.ts's
 * FALLBACK_PHASE_TASK_TEMPLATES, Board v3 — Monday parity round) if
 * the row is somehow missing, mirroring GET /api/settings/phase-template's
 * defensive fallback pattern for its own sibling key.
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
    .eq("key", "phase_task_templates")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Board v3 — Monday parity round: falls back to the real 13-stage
  // checklist (lib/phase-template.ts's FALLBACK_PHASE_TASK_TEMPLATES)
  // instead of `{}` when the app_settings row is missing — same
  // code-fallback mechanism as GET /api/settings/phase-template's own
  // FALLBACK_PHASE_TEMPLATE fallback, and lib/design-task-templates.ts's
  // sibling constant for its own key.
  const templates = (data?.value as PhaseTaskTemplatesMap | undefined) ?? FALLBACK_PHASE_TASK_TEMPLATES;
  return NextResponse.json({ templates });
}

/**
 * PUT /api/settings/phase-task-templates
 * Admin-only (mirrors PUT /api/settings/phase-template's exact
 * gating — same studio-wide-configuration trust tier). Body:
 * PutPhaseTaskTemplatesInput — { templates: { [phaseName]: [{ title,
 * kind }] } } — full replace (upsert onto the single app_settings
 * row). Validates: every phase name maps to an array, every row has a
 * non-empty trimmed title and kind in ('task','milestone'). Does NOT
 * validate phase names against the current app_settings('phase_template')
 * list — a template row for a phase name that's since been renamed/
 * removed from the phase template is simply never applied at seed
 * time (lib/phase-seed.ts looks up by the CURRENT phase template's
 * names), rather than being rejected outright, so editing the two
 * settings in either order never produces a hard error.
 *
 * Does NOT retroactively touch any already-seeded project's
 * board_tasks — same "only affects future seeds" model as the sibling
 * phase_template setting.
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can edit phase task templates" },
      { status: 403 }
    );
  }

  let body: PutPhaseTaskTemplatesInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.templates !== "object" || body.templates === null || Array.isArray(body.templates)) {
    return NextResponse.json({ error: "templates must be an object keyed by phase name" }, { status: 400 });
  }

  const cleaned: PhaseTaskTemplatesMap = {};
  for (const [phaseName, rows] of Object.entries(body.templates)) {
    const name = phaseName.trim();
    if (!name) {
      return NextResponse.json({ error: "Phase name keys cannot be blank" }, { status: 400 });
    }
    if (!Array.isArray(rows)) {
      return NextResponse.json({ error: `Task list for "${name}" must be an array` }, { status: 400 });
    }
    const cleanedRows: PhaseTaskTemplateRow[] = [];
    for (const row of rows) {
      const title = typeof row?.title === "string" ? row.title.trim() : "";
      const kind = row?.kind;
      if (!title) {
        return NextResponse.json({ error: `Every task under "${name}" needs a title` }, { status: 400 });
      }
      if (!VALID_KINDS.has(kind)) {
        return NextResponse.json({ error: "kind must be 'task' or 'milestone'" }, { status: 400 });
      }
      cleanedRows.push({ title, kind });
    }
    cleaned[name] = cleanedRows;
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: "phase_task_templates", value: cleaned, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: cleaned });
}
