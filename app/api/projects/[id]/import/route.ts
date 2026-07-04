import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { parseCsvTable, categoryFromItemCode } from "@/lib/csv";
import type { ImportItemsInput, ImportRowResult } from "@/types";

/**
 * POST /api/projects/[id]/import
 * body: ImportItemsInput — { csv, mapping }.
 *
 * Bulk-creates items from a CSV export (Programa-ish headers — BUILD-SPEC.md
 * §CSV import). Column mapping is decided client-side (the /import page's
 * auto-map + user-confirm step) and passed in as header → item field.
 *
 * Rules:
 *  - An explicit item_code column is respected as-is; the DB trigger
 *    (assign_item_code) only fills in a code when the column is blank/absent,
 *    so mixing explicit and auto-generated codes in one file works.
 *  - Rows whose item_code already exists (active, non-deleted) in this
 *    project are skipped and reported, not overwritten.
 *  - category is taken from a mapped Category column when present,
 *    otherwise derived from the item_code prefix (e.g. "TW-01" -> "TW").
 *    A row with neither a resolvable category nor a mappable one errors.
 *  - Never accepts pricing/procurement columns — this route only writes
 *    spec-view fields, same whitelist intent as PATCH /api/items/[id].
 */
export async function POST(
  request: NextRequest,
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

  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .single();
  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  let body: ImportItemsInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.csv || typeof body.csv !== "string") {
    return NextResponse.json({ error: "csv is required" }, { status: 400 });
  }
  if (!body.mapping || typeof body.mapping !== "object") {
    return NextResponse.json({ error: "mapping is required" }, { status: 400 });
  }

  const { headers, rows } = parseCsvTable(body.csv);
  if (headers.length === 0) {
    return NextResponse.json({ error: "CSV has no header row" }, { status: 400 });
  }
  if (rows.length === 0) {
    return NextResponse.json({ error: "CSV has no data rows" }, { status: 400 });
  }

  // header -> column index, restricted to headers the caller actually mapped
  const colIndexByField = new Map<string, number>();
  headers.forEach((h, i) => {
    const field = body.mapping[h];
    if (field && field !== "notes") {
      colIndexByField.set(field, i);
    }
  });

  function cell(row: string[], field: string): string {
    const idx = colIndexByField.get(field);
    if (idx === undefined) return "";
    const v = (row[idx] ?? "").trim();
    return v === "-" ? "" : v;
  }

  // Known category prefixes, for validating/deriving category.
  const { data: categories } = await supabase.from("categories").select("prefix");
  const validPrefixes = new Set((categories ?? []).map((c) => c.prefix as string));

  // Existing active item codes in this project, to detect duplicates up front.
  const { data: existingItems } = await supabase
    .from("items")
    .select("item_code")
    .eq("project_id", projectId)
    .is("deleted_at", null);
  const existingCodes = new Set(
    (existingItems ?? []).map((i) => (i.item_code as string).toUpperCase())
  );

  const toNum = (v: string): number | null => {
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const results: ImportRowResult[] = [];
  const seenInFile = new Set<string>();
  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 1;

    // Skip fully-blank rows (trailing blank lines etc.)
    if (row.every((c) => !c || !c.trim())) continue;

    const item_code = cell(row, "item_code").toUpperCase() || null;
    const name = cell(row, "name") || cell(row, "description") || null;

    if (!name) {
      results.push({ row: rowNum, item_code, name: null, status: "error", reason: "No name/description value" });
      errored++;
      continue;
    }

    if (item_code) {
      if (existingCodes.has(item_code) || seenInFile.has(item_code)) {
        results.push({ row: rowNum, item_code, name, status: "skipped_duplicate", reason: "item_code already exists in this project" });
        skipped++;
        continue;
      }
    }

    let category = cell(row, "category").toUpperCase() || null;
    if (!category && item_code) {
      category = categoryFromItemCode(item_code);
    }
    if (!category) {
      results.push({ row: rowNum, item_code, name, status: "error", reason: "Could not determine category (no Category column and no code prefix)" });
      errored++;
      continue;
    }
    if (!validPrefixes.has(category)) {
      results.push({ row: rowNum, item_code, name, status: "error", reason: `Unknown category prefix "${category}" — add it under Settings first` });
      errored++;
      continue;
    }

    const insert: Record<string, unknown> = {
      project_id: projectId,
      // Leave item_code blank (undefined key) when absent so the DB trigger
      // assigns it; only set it explicitly when the CSV supplied one.
      ...(item_code ? { item_code } : {}),
      category,
      name,
      description: cell(row, "description") || null,
      supplier: cell(row, "supplier") || null,
      supplier_email: cell(row, "supplier_email") || null,
      brand: cell(row, "brand") || null,
      quantity: toNum(cell(row, "quantity")) ?? 1,
      unit: cell(row, "unit") || "ea",
      location: cell(row, "location") || null,
      application_note: cell(row, "application_note") || null,
      colour: cell(row, "colour") || null,
      material: cell(row, "material") || null,
      finish: cell(row, "finish") || null,
      width_mm: toNum(cell(row, "width_mm")),
      height_mm: toNum(cell(row, "height_mm")),
      length_mm: toNum(cell(row, "length_mm")),
      depth_mm: toNum(cell(row, "depth_mm")),
      created_by: user.id,
    };

    const { error } = await supabase.from("items").insert(insert).select("item_code").single();

    if (error) {
      // 23505 = unique violation (race against a concurrent import/create with the same code)
      const reason =
        error.code === "23505"
          ? "item_code already exists in this project"
          : error.code === "23503"
            ? `Unknown category prefix "${category}"`
            : error.message;
      const status = error.code === "23505" ? "skipped_duplicate" : "error";
      results.push({ row: rowNum, item_code, name, status, reason });
      if (status === "skipped_duplicate") skipped++;
      else errored++;
      continue;
    }

    if (item_code) seenInFile.add(item_code);
    results.push({ row: rowNum, item_code, name, status: "created" });
    created++;
  }

  return NextResponse.json({ created, skipped, errors: errored, results });
}
