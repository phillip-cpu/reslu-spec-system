import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import { syncXeroReadModel } from "@/lib/xero/sync";
import { getXeroConnectionStatus } from "@/lib/xero/status";

export async function POST() {
  const supabase = await createClient();
  const user = await getUserRole(supabase);
  if (!user || user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }
  try {
    const result = await syncXeroReadModel(user.userId);
    return NextResponse.json({ result, status: await getXeroConnectionStatus() });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Xero sync failed" },
      { status: 500 }
    );
  }
}
