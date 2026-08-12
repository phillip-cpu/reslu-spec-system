import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { reconcileSupplierStatement, type SupplierStatementLine } from "@/lib/stuart/supplier-statements";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user || !isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.supplier !== "string" || typeof body.statement_date !== "string" || !Array.isArray(body.lines)) {
    return NextResponse.json({ error: "supplier, statement_date and lines are required" }, { status: 400 });
  }
  try {
    return NextResponse.json(await reconcileSupplierStatement({
      supplier: body.supplier,
      statementDate: body.statement_date,
      sourceFilename: typeof body.source_filename === "string" ? body.source_filename : undefined,
      lines: body.lines as SupplierStatementLine[],
      reviewedBy: user.id,
    }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Statement reconciliation failed" }, { status: 400 });
  }
}
