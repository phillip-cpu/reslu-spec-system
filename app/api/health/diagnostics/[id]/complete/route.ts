import { NextRequest, NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { sendPushToAdmins } from "@/lib/push";
import type { CompleteDiagnosticInput } from "@/types/health-push";

export const runtime = "nodejs";

const REPORT_PREVIEW_CHARS = 200;

/**
 * POST /api/health/diagnostics/[id]/complete
 *
 * Health + web push round (r26), BUILD-SPEC.md item 6 —
 * complete_diagnostic(id, report) MCP tool wraps this route. Same
 * team-Bearer auth as the other mini-facing routes.
 *
 * Body: { status: 'done'|'failed', report }. Only transitions a row
 * still 'pending' or 'running' — an already-completed row is a no-op
 * 200 (idempotent, same "double-POST safe" discipline as this
 * schema's other completion routes), not an error, since a retried
 * request from a flaky mini-side connection is a real scenario this
 * route should tolerate quietly.
 *
 * Fires a completion push whose body is the report's first ~200 chars
 * (item 6's own wording) regardless of done/failed — a failed repair
 * is exactly as important to know about as a successful one.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CompleteDiagnosticInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.report || (body.status !== "done" && body.status !== "failed")) {
    return NextResponse.json(
      { error: "status ('done'|'failed') and report are required." },
      { status: 400 }
    );
  }

  const service = createServiceRoleClient();

  const { data: existing } = await service
    .from("health_diagnostics")
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (!existing) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (existing.status === "done" || existing.status === "failed") {
    return NextResponse.json({ ok: true, diagnostic: existing, already_completed: true });
  }

  const completedAt = new Date().toISOString();
  const { data: updated, error } = await service
    .from("health_diagnostics")
    .update({ status: body.status, report: body.report, completed_at: completedAt })
    .eq("id", id)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const title = body.status === "done" ? "Diagnostics complete" : "Diagnostics failed";
  const preview = body.report.slice(0, REPORT_PREVIEW_CHARS);
  await service.from("notifications").insert({
    user_id: null,
    kind: "diagnostics_done",
    title,
    body: preview,
    link_href: "/health",
  });
  await sendPushToAdmins("diagnostics_done", title, preview, "/health");

  return NextResponse.json({ ok: true, diagnostic: updated, already_completed: false });
}
