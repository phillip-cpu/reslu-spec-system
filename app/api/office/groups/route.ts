import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { CreateOfficeGroupInput } from "@/types/phase-13";

const SORT_STEP = 1000;

/**
 * POST /api/office/groups
 * body: { name (required) }. Response: { group }. New department
 * groups are added after every existing group (max(sort)+1000), same
 * ladder scheme as board_columns/board_groups.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: CreateOfficeGroupInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body.name?.trim()) {
    return NextResponse.json({ error: "name is required" }, { status: 400 });
  }

  const { data: maxRow } = await supabase
    .from("office_groups")
    .select("sort")
    .is("deleted_at", null)
    .order("sort", { ascending: false })
    .limit(1)
    .maybeSingle();

  const nextSort = (maxRow?.sort ?? -SORT_STEP) + SORT_STEP;

  const { data: group, error } = await supabase
    .from("office_groups")
    .insert({ name: body.name.trim(), sort: nextSort })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ group }, { status: 201 });
}
