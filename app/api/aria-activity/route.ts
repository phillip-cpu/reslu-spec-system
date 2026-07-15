import { NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadAriaActivity } from "@/lib/aria-activity";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  return NextResponse.json(await loadAriaActivity(supabase));
}

