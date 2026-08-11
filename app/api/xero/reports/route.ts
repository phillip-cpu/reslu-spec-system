import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { xeroReportDefinition } from "@/lib/xero/report-definitions";
import { pullXeroReport } from "@/lib/xero/reports";
import type { XeroReportKey } from "@/types/xero";

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  try {
    const body = (await request.json()) as {
      report?: string;
      fromDate?: string;
      toDate?: string;
      date?: string;
    };
    if (!body.report || !xeroReportDefinition(body.report)) {
      return NextResponse.json({ error: "Choose a supported Xero report" }, { status: 400 });
    }
    const result = await pullXeroReport({
      report: body.report as XeroReportKey,
      fromDate: body.fromDate,
      toDate: body.toDate,
      date: body.date,
    });
    return NextResponse.json({ result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Xero report failed";
    const friendly = message.includes("(403)")
      ? "Your Xero user needs permission to view Reports in this organisation."
      : message;
    return NextResponse.json({ error: friendly }, { status: 500 });
  }
}
