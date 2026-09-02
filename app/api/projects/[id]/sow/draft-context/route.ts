import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { roomSectionTemplate } from "@/lib/sow-templates";
import { groundedRoomSectionTemplate } from "@/lib/sow-grounded-template";
import {
  planFilenamesForSowRoom,
  sowRoomAwaitsWorkingDrawings,
  sowRoomPlanScope,
} from "@/lib/sow-plan-scope";
import type { Item } from "@/types";
import type { PlanAnalysis } from "@/types/phase-12a-a";

/**
 * GET /api/projects/[id]/sow/draft-context
 * BUILD-SPEC.md "SOW drafting": "Aria drafts room-by-room sections
 * grounded in the analysis (rooms from plans, items from register per
 * room, clause patterns from library) via MCP tool draft_sow_section."
 *
 * This route is the FETCH half of that MCP tool (see mcp/src/index.mjs
 * draft_sow_section, fetch mode) — read-only, returns everything Aria
 * needs to ground a room-by-room draft: the project's current rooms
 * (from the `rooms` table — the CURRENT schema, not items.location),
 * each room's assigned FF&E items (via item_rooms), the latest plan
 * analysis's discrepancies (so Aria can flag rather than silently
 * gloss over a known mismatch while drafting), and the room-section
 * clause pattern skeleton from lib/sow-templates.ts for the sub-
 * heading structure to follow. The SUBMIT half (writing draft
 * sow_lines) reuses the existing POST /api/sow/sections/[sectionId]/lines
 * route directly — no separate submit endpoint needed, since that
 * route already does exactly "add a line to a draft SOW section" with
 * no financial gating, which is all a submitted draft section needs.
 *
 * Team access (not admin-gated — SOW/rooms/items design data, no
 * pricing exposed by this route at all).
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: projectId } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: rooms }, { data: analyses }, { data: planFiles }] = await Promise.all([
    supabase
      .from("rooms")
      .select("id, name")
      .eq("project_id", projectId)
      .is("deleted_at", null)
      .order("sort", { ascending: true }),
    supabase
      .from("plan_analyses")
      .select("*")
      .eq("project_id", projectId)
      .order("analysed_at", { ascending: false })
      .limit(50),
    supabase
      .from("project_files")
      .select("id, filename")
      .eq("project_id", projectId)
      .eq("kind", "plans")
      .is("deleted_at", null)
      .order("uploaded_at", { ascending: false }),
  ]);

  const roomIds = (rooms ?? []).map((r) => r.id as string);

  // Fetched only once room ids are known (a room-less project skips
  // this query entirely) — two sequential round trips is an acceptable
  // cost for a read-only, Aria-polled drafting-context endpoint, not a
  // hot path.
  const { data: allocations } = roomIds.length
    ? await supabase
        .from("item_rooms")
        .select("room_id, quantity, items(item_code, name, description, category)")
        .in("room_id", roomIds)
    : { data: [] as unknown[] };

  const itemsByRoom = new Map<string, { item_code: string; name: string; description: string | null; category: string; quantity: number }[]>();
  for (const row of (allocations ?? []) as {
    room_id: string;
    quantity: number;
    items: Pick<Item, "item_code" | "name" | "description" | "category"> | null;
  }[]) {
    if (!row.items) continue;
    const list = itemsByRoom.get(row.room_id) ?? [];
    list.push({ ...row.items, quantity: row.quantity });
    itemsByRoom.set(row.room_id, list);
  }

  // A project can have separate interior, joinery and external plan
  // sets. Return the newest analysis for each current file rather than
  // letting the last upload silently replace all earlier context.
  const currentPlanIds = new Set((planFiles ?? []).map((file) => String(file.id)));
  const latestAnalysisByFile = new Map<string, PlanAnalysis>();
  for (const analysis of (analyses ?? []) as unknown as PlanAnalysis[]) {
    if (!currentPlanIds.has(analysis.file_id) || latestAnalysisByFile.has(analysis.file_id)) continue;
    latestAnalysisByFile.set(analysis.file_id, analysis);
  }
  const currentAnalyses = [...latestAnalysisByFile.values()];
  const planFilenames = (planFiles ?? []).map((file) => String(file.filename));

  const roomsWithItems = (rooms ?? []).map((r) => {
    const roomName = r.name as string;
    const items = itemsByRoom.get(r.id as string) ?? [];
    const applicablePlanFilenames = planFilenamesForSowRoom(roomName, planFilenames);
    const awaitsWorkingDrawings = sowRoomAwaitsWorkingDrawings(roomName, planFilenames);
    return {
      id: r.id,
      name: r.name,
      items,
      plan_scope: sowRoomPlanScope(roomName),
      drafting_status: awaitsWorkingDrawings ? "awaiting_working_drawings" : "ready_for_review",
      applicable_plan_files: applicablePlanFilenames,
      clause_pattern: awaitsWorkingDrawings
        ? null
        : items.length > 0 || applicablePlanFilenames.length > 0
          ? groundedRoomSectionTemplate({
              roomName,
              items: items.map((item) => ({
                ...item,
                colour: null,
                material: null,
                finish: null,
              })),
              planFilenames: applicablePlanFilenames,
            })
          : roomSectionTemplate(roomName),
    };
  });

  return NextResponse.json({
    rooms: roomsWithItems,
    latest_plan_analysis: currentAnalyses[0] ?? null,
    plan_analyses: currentAnalyses,
    plan_files: planFiles ?? [],
  });
}
