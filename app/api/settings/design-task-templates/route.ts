import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { FALLBACK_DESIGN_TASK_TEMPLATES } from "@/lib/design-task-templates";
import type { DesignTaskTemplateRow, DesignTaskTemplatesMap, PutDesignTaskTemplatesInput } from "@/types/round-c";

/**
 * GET /api/settings/design-task-templates
 * "Two from Phillip — 7 July 2026" item 2 — "Design board tasks
 * pre-populated from the Monday template", mirroring
 * GET /api/settings/phase-task-templates' exact shape (its own sibling
 * on app_settings, one key over). Team-visible (studio-wide
 * configuration, not financial). Response: { templates } — an object
 * keyed by design-phase NAME (types/phase-12b.ts's
 * DESIGN_PHASE_TEMPLATE) -> its seed task list.
 *
 * Falls back to lib/design-task-templates.ts's
 * FALLBACK_DESIGN_TASK_TEMPLATES (extracted from
 * docs/DESIGN-FRAMEWORK-BRIEF.md — see that file's header comment) if
 * the app_settings row is absent — code-level fallback, NOT a new
 * migration seed (this round's explicit "no schema" boundary; contrast
 * with migration 029's SQL-level seed for the sibling
 * 'phase_task_templates' key, which pre-dates this round and is a
 * different mechanism this round deliberately does not repeat).
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
    .eq("key", "design_task_templates")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const templates = (data?.value as DesignTaskTemplatesMap | undefined) ?? FALLBACK_DESIGN_TASK_TEMPLATES;
  return NextResponse.json({ templates });
}

/**
 * PUT /api/settings/design-task-templates
 * Admin-only (mirrors PUT /api/settings/phase-task-templates' exact
 * gating — same studio-wide-configuration trust tier). Body:
 * PutDesignTaskTemplatesInput — { templates: { [phaseName]: [{ title }] } }
 * — full replace (upsert onto the single app_settings row). Validates:
 * every phase name maps to an array, every row has a non-empty trimmed
 * title. Does NOT validate phase names against
 * types/phase-12b.ts's fixed DESIGN_PHASE_TEMPLATE list — a template
 * row for a phase name that doesn't match is simply never applied at
 * seed time (the seed loop looks up by the CURRENT fixed phase list's
 * names), rather than rejected outright, same permissive-write /
 * strict-read-time-lookup rule PUT /api/settings/phase-task-templates
 * already uses for its own sibling key.
 *
 * Does NOT retroactively touch any already-seeded project's
 * design_tasks — same "only affects future seeds" model as every other
 * template editor in this app.
 */
export async function PUT(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can edit design task templates" },
      { status: 403 }
    );
  }

  let body: PutDesignTaskTemplatesInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.templates !== "object" || body.templates === null || Array.isArray(body.templates)) {
    return NextResponse.json({ error: "templates must be an object keyed by phase name" }, { status: 400 });
  }

  const cleaned: DesignTaskTemplatesMap = {};
  for (const [phaseName, rows] of Object.entries(body.templates)) {
    const name = phaseName.trim();
    if (!name) {
      return NextResponse.json({ error: "Phase name keys cannot be blank" }, { status: 400 });
    }
    if (!Array.isArray(rows)) {
      return NextResponse.json({ error: `Task list for "${name}" must be an array` }, { status: 400 });
    }
    const cleanedRows: DesignTaskTemplateRow[] = [];
    for (const row of rows) {
      const title = typeof row?.title === "string" ? row.title.trim() : "";
      if (!title) {
        return NextResponse.json({ error: `Every task under "${name}" needs a title` }, { status: 400 });
      }
      cleanedRows.push({ title });
    }
    cleaned[name] = cleanedRows;
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert(
      { key: "design_task_templates", value: cleaned, updated_at: new Date().toISOString() },
      { onConflict: "key" }
    );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: cleaned });
}
