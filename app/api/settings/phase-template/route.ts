import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import {
  PROJECT_TYPES,
  resolveProjectPhaseTemplates,
  type ProjectPhaseTemplates,
} from "@/lib/project-templates";
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

  return NextResponse.json({ templates: resolveProjectPhaseTemplates(data?.value) });
}

/**
 * PUT /api/settings/phase-template
 * Admin-only (mirrors PATCH /api/categories/[id]'s admin gating —
 * this is studio-wide configuration, not per-project data). Body:
 * PutPhaseTemplateInput — { templates: { [projectType]: [{ name, kind }] } }
 * — full replace. Each of the four project types must have a non-empty
 * template. A template may have zero or one umbrella row; the seed path is
 * explicitly null-safe when no umbrella is present.
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

  if (!body.templates || typeof body.templates !== "object" || Array.isArray(body.templates)) {
    return NextResponse.json({ error: "templates must be keyed by project type" }, { status: 400 });
  }

  const cleaned = {} as ProjectPhaseTemplates;
  for (const projectType of PROJECT_TYPES) {
    const rows = body.templates[projectType];
    if (!Array.isArray(rows) || rows.length === 0) {
      return NextResponse.json(
        { error: `${projectType} needs at least one Timeline stage` },
        { status: 400 }
      );
    }

    const names = new Set<string>();
    const cleanedRows: AppSettingsPhaseTemplateRow[] = [];
    for (const row of rows) {
      const name = typeof row?.name === "string" ? row.name.trim() : "";
      const kind = row?.kind;
      if (!name) {
        return NextResponse.json({ error: "Every phase needs a name" }, { status: 400 });
      }
      if (!VALID_KINDS.has(kind)) {
        return NextResponse.json({ error: "kind must be 'phase' or 'umbrella'" }, { status: 400 });
      }
      if (names.has(name.toLocaleLowerCase())) {
        return NextResponse.json(
          { error: `Stage names must be unique within ${projectType}` },
          { status: 400 }
        );
      }
      names.add(name.toLocaleLowerCase());
      cleanedRows.push({ name, kind });
    }
    if (cleanedRows.filter((row) => row.kind === "umbrella").length > 1) {
      return NextResponse.json(
        { error: `${projectType} can have at most one umbrella stage` },
        { status: 400 }
      );
    }
    cleaned[projectType] = cleanedRows;
  }

  const { error } = await supabase
    .from("app_settings")
    .upsert({ key: "phase_template", value: cleaned, updated_at: new Date().toISOString() }, { onConflict: "key" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ templates: cleaned });
}
