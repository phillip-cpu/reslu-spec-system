import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { customerReceiptsEnabled, recordStuartXeroCustomerReceipts } from "@/lib/stuart/xero-customer-receipts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!customerReceiptsEnabled()) return NextResponse.json({ error: "Customer receipt recording is disabled pending reviewed activation" }, { status: 503 });
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 32_768) return NextResponse.json({ error: "Receipt request is too large" }, { status: 413 });
    body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
  } catch { return NextResponse.json({ error: "A receipt plan and exact approval envelope are required" }, { status: 400 }); }
  const { _authority, ...plan } = body;
  try {
    const result = await recordStuartXeroCustomerReceipts(plan, _authority, user.id);
    // Preserve partial allocation/payment IDs through MCP's successful JSON path.
    // The business outcome is result.state, never the HTTP status alone.
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Customer receipt recording failed; inspect the audit before retrying" }, { status: 409 });
  }
}
