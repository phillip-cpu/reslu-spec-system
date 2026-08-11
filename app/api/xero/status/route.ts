import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { hasXeroAccess } from "@/lib/xero/access";
import { getXeroConnectionStatus } from "@/lib/xero/status";

export async function GET() {
  const supabase = await createClient();
  if (!hasXeroAccess(await getUserRole(supabase))) {
    return NextResponse.json({ error: "Xero access required" }, { status: 403 });
  }
  return NextResponse.json({ status: await getXeroConnectionStatus() });
}
