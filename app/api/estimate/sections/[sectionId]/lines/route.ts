import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateCostLineInput } from "@/types";

const VALID_QUOTE_STATUS = new Set(["Q", "S", "NA"]);

/**
 * POST /api/estimate/sections/[sectionId]/lines
 * Adds a new cost line to a section. project_id is looked up from the
 * parent section server-side (never trusted from the client) so the
 * cost_lines.project_id denormalised column (BUILD-SPEC.md: "project_id
 * (denormalised for queries)") can never drift from its true section's
 * project.
 *
 * Admin-only, per BUILD-SPEC.md §Financial visibility.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ sectionId: string }> }
) {
  const { sectionId } = await params;
  const supabase = await createClient();

  const info = await getUserRole(supabase);
  if (!info) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (info.role !== "admin") {
    return NextResponse.json(
      { error: "Only admins can access the Estimate module" },
      { status: 403 }
    );
  }

  const { data: section } = await supabase
    .from("cost_sections")
    .select("id, project_id")
    .eq("id", sectionId)
    .single();
  if (!section) {
    return NextResponse.json({ error: "Section not found" }, { status: 404 });
  }

  let body: CreateCostLineInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body?.description?.trim()) {
    return NextResponse.json({ error: "description is required" }, { status: 400 });
  }
  if (body.quote_status && !VALID_QUOTE_STATUS.has(body.quote_status)) {
    return NextResponse.json(
      { error: "quote_status must be one of Q, S, NA" },
      { status: 400 }
    );
  }

  const { data: existing } = await supabase
    .from("cost_lines")
    .select("sort")
    .eq("section_id", sectionId)
    .order("sort", { ascending: false })
    .limit(1);
  const nextSort = (existing?.[0]?.sort ?? 0) + 1;

  const toNum = (v: unknown) => (v === undefined || v === null || v === ("" as unknown) ? null : Number(v));

  const { data: line, error } = await supabase
    .from("cost_lines")
    .insert({
      section_id: sectionId,
      project_id: section.project_id,
      description: body.description.trim(),
      qty: toNum(body.qty),
      unit: body.unit?.trim() || null,
      rate_ex_gst: toNum(body.rate_ex_gst),
      cost_ex_gst: toNum(body.cost_ex_gst),
      quoted_to_client_ex_gst: toNum(body.quoted_to_client_ex_gst),
      actual_paid_ex_gst: toNum(body.actual_paid_ex_gst),
      quote_status: body.quote_status ?? null,
      item_id: body.item_id ?? null,
      notes: body.notes?.trim() || null,
      sort: nextSort,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ line }, { status: 201 });
}
