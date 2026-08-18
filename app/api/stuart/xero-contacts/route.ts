import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { isStuartUser } from "@/lib/stuart/access";
import { searchStuartXeroContacts } from "@/lib/stuart/xero-contacts";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!isStuartUser(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    return NextResponse.json(await searchStuartXeroContacts(request.nextUrl.searchParams.get("q") ?? ""));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Xero contact search failed" }, { status: 400 });
  }
}
