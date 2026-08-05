import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { normalizeProductUrl } from "@/lib/scraper";
import {
  BROWSER_IMPORT_FIELDS,
  importedFieldValues,
  validateBrowserProductImport,
  type BrowserImportField,
  type BrowserProductDetail,
} from "@/lib/browser-product-import";

const IMPORT_FIELD_SET = new Set<string>(BROWSER_IMPORT_FIELDS);

function mergeDetails(
  current: unknown,
  imported: BrowserProductDetail[]
): BrowserProductDetail[] {
  const rows = Array.isArray(current)
    ? current.filter(
        (entry): entry is BrowserProductDetail =>
          !!entry &&
          typeof entry === "object" &&
          typeof (entry as BrowserProductDetail).label === "string" &&
          typeof (entry as BrowserProductDetail).value === "string"
      )
    : [];
  const byLabel = new Map(rows.map((entry) => [entry.label.toLowerCase(), entry]));
  for (const entry of imported) byLabel.set(entry.label.toLowerCase(), entry);
  return [...byLabel.values()].slice(0, 80);
}

function mergeImages(current: unknown, imported: string[]): string[] {
  const existing = Array.isArray(current)
    ? current.filter((value): value is string => typeof value === "string")
    : [];
  return [...new Set([...existing, ...imported])].slice(0, 20);
}

/**
 * POST /api/items/[id]/browser-import
 *
 * Applies only the fields the team member confirmed on the browser-import
 * review screen. The source page itself is never fetched here: the browser
 * extension supplies a small, normalized payload from the page the user has
 * already opened. expectedUpdatedAt prevents a stale review from silently
 * overwriting an FF&E item that changed in another tab.
 */
export async function POST(
  request: NextRequest,
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

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const validation = validateBrowserProductImport(body.payload);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const selectedFields = Array.isArray(body.selectedFields)
    ? body.selectedFields.filter(
        (field): field is BrowserImportField =>
          typeof field === "string" && IMPORT_FIELD_SET.has(field)
      )
    : [];
  if (selectedFields.length === 0) {
    return NextResponse.json(
      { error: "Choose at least one field to import." },
      { status: 400 }
    );
  }
  const expectedUpdatedAt =
    typeof body.expectedUpdatedAt === "string" ? body.expectedUpdatedAt : null;
  if (!expectedUpdatedAt) {
    return NextResponse.json(
      { error: "The item version is missing. Reload the item and review it again." },
      { status: 400 }
    );
  }

  const { data: current, error: readError } = await supabase
    .from("items")
    .select("updated_at,product_details,image_options")
    .eq("id", id)
    .is("deleted_at", null)
    .single();
  if (readError || !current) {
    return NextResponse.json({ error: "Item not found" }, { status: 404 });
  }
  if (current.updated_at !== expectedUpdatedAt) {
    return NextResponse.json(
      {
        error:
          "This FF&E item changed after you opened the review. Reload it before importing.",
      },
      { status: 409 }
    );
  }
  const values = importedFieldValues(validation.payload);
  const update: Record<string, unknown> = {
    scrape_status: "vision",
    scrape_attempted_at: new Date().toISOString(),
    scrape_flagged: false,
    scrape_flag_note: null,
  };
  for (const field of selectedFields) {
    const value = values[field];
    if (value === null || value === undefined || value === "") continue;
    if (field === "product_details") {
      update.product_details = mergeDetails(current.product_details, value as BrowserProductDetail[]);
    } else if (field === "image_options") {
      update.image_options = mergeImages(current.image_options, value as string[]);
    } else {
      update[field] = value;
    }
  }
  if ("product_url" in update) {
    update.product_url_normalized = normalizeProductUrl(update.product_url as string);
  }

  const { data: item, error: updateError } = await supabase
    .from("items")
    .update(update)
    .eq("id", id)
    .eq("updated_at", expectedUpdatedAt)
    .is("deleted_at", null)
    .select()
    .single();
  if (updateError || !item) {
    if (updateError?.code === "PGRST116") {
      return NextResponse.json(
        { error: "The item changed while the import was being saved. Review it again." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: updateError?.message ?? "Browser import could not be saved." },
      { status: 500 }
    );
  }

  return NextResponse.json({ item, importedFields: selectedFields });
}
