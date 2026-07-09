import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateBriefItemInput, DailyBriefItem } from "@/types/round-daily-brief";

export const runtime = "nodejs";

/**
 * POST /api/brief/items
 * BUILD-SPEC.md "Daily Brief" routes list: "POST /api/brief/items
 * (manual/Aria)." body: CreateBriefItemInput — { title (required),
 * source? ('manual' default | 'aria'), link_href?, project_id? }.
 *
 * Auth: standard session (team panel inline-add) OR a Bearer JWT
 * (Aria's real admin account, via the SAME Authorization-header branch
 * lib/supabase/server.ts's createClient() already resolves for every
 * other Aria-authenticated route in this codebase — no separate
 * CRON_SECRET path needed here, this isn't a cron route). Admin-gated,
 * same as every other /api/brief* route (see GET /api/brief's own doc
 * comment for the full "brief is admin-facing v1" rationale) — Aria's
 * account already carries the admin role for exactly this reason (see
 * mcp/src/index.mjs's list_leads tool description).
 *
 * `source` defaults to 'manual' (the panel's own inline-add form never
 * sends this field) — passing 'aria' explicitly is how the
 * `add_brief_item` MCP tool distinguishes itself; no OTHER source
 * value is ever accepted here (booking/ordering/lead/trade are
 * system-generated only, by the generator; email/invoice are reserved
 * for a future pipeline — see daily_brief_items.source's own column
 * comment, migration 041). `created_by_kind` is derived from `source`
 * (never trusted as a separate input) — 'aria' when source is 'aria',
 * else 'user'; `created_by` is always the authenticated caller's own
 * profile id either way (both Aria and a human team member are real
 * `profiles` rows).
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "The Daily Brief is admin-only in v1." }, { status: 403 });
  }

  let body: CreateBriefItemInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }

  const source = body.source === "aria" ? "aria" : "manual";

  if (body.project_id) {
    const { data: project } = await supabase.from("projects").select("id").eq("id", body.project_id).single();
    if (!project) {
      return NextResponse.json({ error: "project_id does not exist" }, { status: 400 });
    }
  }

  const { data: item, error } = await supabase
    .from("daily_brief_items")
    .insert({
      title: body.title.trim(),
      source,
      link_href: body.link_href?.trim() || null,
      project_id: body.project_id || null,
      status: "open",
      created_by_kind: source === "aria" ? "aria" : "user",
      created_by: info.userId,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ item: item as DailyBriefItem }, { status: 201 });
}
