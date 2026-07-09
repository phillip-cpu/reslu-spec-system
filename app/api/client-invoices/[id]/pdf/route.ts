import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { InvoicePdf } from "@/components/pdf/InvoicePdf";
import { loadClientInvoicePdfData } from "@/lib/client-invoice-pdf-data";

// react-pdf + font/logo file reads require the Node runtime — same as
// GET /api/projects/[id]/pdf and GET /api/projects/[id]/sow/[sowId]/pdf.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/client-invoices/[id]/pdf
 * Renders the branded tax invoice PDF (BUILD-SPEC.md "Phillip's ideas
 * list — 6 July 2026" item 5). Admin-only — this is financial/client
 * contact data, same tier as GET /api/projects/[id]/invoices (the
 * supplier invoice queue). Works for an invoice in ANY status
 * (draft/sent/paid/void) — a draft render is exactly what the "preview
 * PDF" composer action uses before Send is ever clicked.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access client invoices" }, { status: 403 });
  }

  const data = await loadClientInvoicePdfData(supabase, id);
  if (!data) {
    return NextResponse.json({ error: "Invoice not found" }, { status: 404 });
  }

  const buffer = await renderToBuffer(InvoicePdf(data));

  const filename = `RESLU-Invoice-${data.invoice.invoice_number}.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
