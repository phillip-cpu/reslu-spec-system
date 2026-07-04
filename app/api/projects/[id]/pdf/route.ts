import { NextRequest, NextResponse } from "next/server";
import { renderToBuffer } from "@react-pdf/renderer";
import { createClient } from "@/lib/supabase/server";
import { SchedulePdf } from "@/components/pdf/SchedulePdf";
import type { Category, Item } from "@/types";

// react-pdf + font/logo file reads require the Node runtime.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/projects/[id]/pdf
 * Renders the builder-facing FF&E schedule PDF (BUILD-SPEC.md §10).
 * Carries NO pricing or ordering data — the same spec-only field set
 * as the client portal.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const [{ data: project }, { data: items }, { data: categories }] =
    await Promise.all([
      supabase.from("projects").select("*").eq("id", id).single(),
      supabase
        .from("items")
        .select("*")
        .eq("project_id", id)
        .is("deleted_at", null)
        .order("category", { ascending: true })
        .order("item_code", { ascending: true }),
      supabase.from("categories").select("*").order("sort_order"),
    ]);

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const generatedAt = new Date().toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const buffer = await renderToBuffer(
    SchedulePdf({
      project,
      items: (items ?? []) as Item[],
      categories: (categories ?? []) as Category[],
      generatedAt,
    })
  );

  const filename = `${project.name.replace(/[^a-z0-9]+/gi, "-")}-FFE-Schedule.pdf`;

  return new NextResponse(new Uint8Array(buffer), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}
