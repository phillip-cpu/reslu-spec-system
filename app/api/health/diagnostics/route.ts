import { NextResponse } from "next/server";
import { createClient, createServiceRoleClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { sendPushToAdmins } from "@/lib/push";
import type { CreateDiagnosticResponse } from "@/types/health-push";

export const runtime = "nodejs";

/**
 * POST /api/health/diagnostics
 *
 * Health + web push round (r26), BUILD-SPEC.md item 4: "'Run
 * diagnostics & repair' button -> inserts health_diagnostics pending +
 * notification on completion." Admin-only, explicit button press from
 * the Health page — this is the ONLY way a diagnostics run is ever
 * queued; nothing in this round triggers it automatically (the
 * standing credits ruling: "Claude Code repair sessions run ONLY on
 * explicit button press" — this route is that press, for the mini's
 * own dumb repair script, never a Claude Code session itself).
 *
 * Fires a 'diagnostics_requested' notification immediately (not
 * deduped — every press is a genuinely new, intentional request, not a
 * recurring incident) so admins other than the one who pressed it can
 * see a run is in flight.
 */
export async function POST() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info || info.role !== "admin") {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const service = createServiceRoleClient();

  const { data: diagnostic, error } = await service
    .from("health_diagnostics")
    .insert({ requested_by: info.userId, status: "pending" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const title = "Diagnostics requested";
  const body = "A health diagnostics & repair run was requested and is waiting for the mini to pick it up.";
  await service.from("notifications").insert({
    user_id: null,
    kind: "diagnostics_requested",
    title,
    body,
    link_href: "/health",
  });
  await sendPushToAdmins("diagnostics_requested", title, body, "/health");

  const response: CreateDiagnosticResponse = { diagnostic };
  return NextResponse.json(response);
}
