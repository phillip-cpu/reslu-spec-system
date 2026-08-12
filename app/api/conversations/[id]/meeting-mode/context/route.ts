import { NextRequest, NextResponse } from "next/server";
import { meetingModeContext, requireMeetingModeAccess } from "@/lib/meeting-mode-server";
import { createClient } from "@/lib/supabase/server";
import type { MeetingContextResponse } from "@/types/meeting-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireMeetingModeAccess(supabase, id, user.id);
  if (access.error) return NextResponse.json({ error: access.error }, { status: 404 });

  try {
    const context = await meetingModeContext(supabase, id);
    const body: MeetingContextResponse = {
      current_user_id: user.id,
      candidates: context.candidates,
      suggested: context.suggested,
      needs_clarification: context.needsClarification,
      clarification: context.needsClarification ? "Which lead or project is this meeting for?" : null,
      active_minutes: context.activeMinutes,
    };
    return NextResponse.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not resolve meeting context" }, { status: 500 });
  }
}
