import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { prepareStuartXeroCustomerReceipts } from "@/lib/stuart/xero-customer-receipts-prepare";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST avoids source IDs/account suffixes in query-string logs. The handler is read-only.
export async function POST(request: NextRequest) {
  const client = await createClient();
  const { data: { user } } = await client.auth.getUser();
  if (!user || !isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  try {
    const text = await request.text();
    if (text.length > 32_768) return NextResponse.json({ error: "Preparation request is too large" }, { status: 413 });
    return NextResponse.json(await prepareStuartXeroCustomerReceipts(JSON.parse(text), user.id));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Customer receipt preparation failed" }, { status: 400 });
  }
}
