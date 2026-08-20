import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { classifyUnallocatedInvoice } from "@/lib/stuart/unallocated-invoices";
import type { FinanceRecurringCategory } from "@/types/finance";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.invoice_id !== "string" || body.human_confirmed !== true) {
    return NextResponse.json({ error: "invoice_id and human_confirmed=true are required" }, { status: 400 });
  }
  try {
    if (body.scope === "project" && typeof body.project_id === "string") {
      return NextResponse.json(await classifyUnallocatedInvoice({
        invoiceId: body.invoice_id,
        scope: "project",
        projectId: body.project_id,
        humanConfirmed: true,
      }));
    }
    if (body.scope === "company" && typeof body.category === "string") {
      return NextResponse.json(await classifyUnallocatedInvoice({
        invoiceId: body.invoice_id,
        scope: "company",
        category: body.category as FinanceRecurringCategory,
        recurringCommitmentId: typeof body.recurring_commitment_id === "string" ? body.recurring_commitment_id : null,
        humanConfirmed: true,
      }));
    }
    return NextResponse.json({ error: "Choose project with project_id, or company with category" }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invoice classification failed" }, { status: 400 });
  }
}
