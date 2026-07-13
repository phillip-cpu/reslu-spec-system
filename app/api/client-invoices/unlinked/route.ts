import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { ClientInvoice, UnlinkedClientInvoicesResponse } from "@/types/client-invoices";

export const runtime = "nodejs";

/**
 * GET /api/client-invoices/unlinked
 *
 * BUILD-SPEC.md r27 item 7 — "Orphaned deposit invoices ... Invoices
 * tab (or Office) gains an 'Unlinked invoices' list showing
 * project_id-null rows." There is deliberately no global client-
 * invoices list route (see components/invoices/ClientInvoiceQueue.tsx's
 * own header comment: "Global /invoices list? SKIP v1 (project-scoped
 * only, document)") and the existing Invoices tab
 * (app/(dashboard)/projects/[id]/invoices/page.tsx) is inherently
 * project-scoped, so it structurally cannot show a project_id-null
 * row. This is the one small new surface that round needs — a single
 * admin-only read route, deliberately not a whole new page (see
 * components/leads/UnlinkedInvoicesPanel.tsx's own header comment for
 * where it's mounted and why).
 *
 * Admin-only — same tier as every other client_invoices read (money
 * IN, client contact data). Returns every non-deleted row with
 * project_id still null, regardless of whether it carries a lead_id
 * (migration 054) — a manually-created orphan with no lead at all must
 * be just as visible as a lead-originated one.
 */
export async function GET() {
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access client invoices" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("client_invoices")
    .select("*")
    .is("project_id", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ invoices: (data ?? []) as ClientInvoice[] } as UnlinkedClientInvoicesResponse);
}
