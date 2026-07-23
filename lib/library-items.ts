import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeProductUrl } from "@/lib/scraper";

export async function copyLibraryAssemblyComponentsToItem(
  supabase: SupabaseClient,
  libraryItemId: string,
  itemId: string,
  createdBy: string
) {
  const { data: templates, error } = await supabase
    .from("library_item_components")
    .select("*, component_library_item:library_items!component_library_item_id(*)")
    .eq("parent_library_item_id", libraryItemId)
    .order("sort", { ascending: true });
  if (error || !templates?.length) return [];

  const rows = templates.map((template) => {
    const linked = template.component_library_item as Record<string, unknown> | null;
    return {
      item_id: itemId,
      library_item_id: template.component_library_item_id,
      name: template.name,
      supplier: template.supplier ?? linked?.supplier ?? null,
      supplier_email: template.supplier_email ?? linked?.supplier_email ?? null,
      brand: template.brand ?? linked?.brand ?? null,
      supplier_item_code: template.supplier_item_code,
      quantity_per_item: template.quantity_per_item,
      unit: template.unit,
      price_trade: linked?.price_trade ?? template.price_trade ?? null,
      finish: template.finish ?? linked?.finish ?? null,
      product_url: template.product_url ?? linked?.product_url ?? null,
      lead_time_weeks: template.lead_time_weeks,
      trade_price_received_at: linked?.trade_price_received_at ?? null,
      trade_price_source: linked?.trade_price_source ?? null,
      sort: template.sort,
      created_by: createdBy,
    };
  });
  const { data: components } = await supabase.from("item_components").insert(rows).select();
  return components ?? [];
}

/**
 * Copies a single library_items row onto a project's spec register as
 * a new `items` row — this is the EXACT insert shape
 * `POST /api/projects/[id]/items` already builds when its body carries
 * `library_item_id` (see that route's `libraryDefaults` hydration +
 * insert call), extracted here so a SECOND copy site — Create Project's
 * "Standard spec items" checklist (POST /api/projects) and the leads
 * "Progress to job" handoff (POST /api/leads/[id]/create-project),
 * both new in the migration 030 round — can call the SAME logic
 * instead of a forked copy of it. `POST /api/projects/[id]/items`
 * itself is untouched by this round (not in this round's file list)
 * and keeps building the identical shape inline for its own single-item
 * add flow; this function is for the two NEW bulk-at-creation call
 * sites only.
 *
 * item_code is deliberately left for the DB trigger
 * (assign_item_code(), 001_initial.sql) to generate, same as every
 * other item-creation path — never set here.
 *
 * Best-effort usage tracking (usage_count++ and the
 * project_library_items upsert) mirrors the existing route's
 * post-insert side effects exactly. Scraping is NOT triggered here —
 * a standard item's product_url was already scraped once when it was
 * first added to the library (or scraped on its next manual edit);
 * re-scraping N standard items on every new project would be
 * needless load for data the library copy already carries.
 *
 * Returns the created item row, or throws with the same Postgres error
 * surfaced by supabase-js on failure (category FK violation, etc.) —
 * callers catch/translate exactly as the existing single-item route
 * already does for its own insert.
 */
export async function copyLibraryItemToProject(
  supabase: SupabaseClient,
  projectId: string,
  libraryItemId: string,
  createdBy: string
) {
  const { data: lib, error: libError } = await supabase
    .from("library_items")
    .select("*")
    .eq("id", libraryItemId)
    .single();

  if (libError || !lib) {
    throw new Error(`Library item ${libraryItemId} not found`);
  }

  const { data: item, error } = await supabase
    .from("items")
    .insert({
      project_id: projectId,
      category: lib.category,
      name: lib.name,
      description: lib.description,
      supplier: lib.supplier,
      supplier_email: lib.supplier_email,
      brand: lib.brand,
      quantity: 1,
      colour: lib.colour,
      material: lib.material,
      finish: lib.finish,
      width_mm: lib.width_mm,
      height_mm: lib.height_mm,
      length_mm: lib.length_mm,
      depth_mm: lib.depth_mm,
      product_url: lib.product_url,
      product_url_normalized: normalizeProductUrl(lib.product_url ?? null),
      selected_image_url: lib.default_image_url,
      price_rrp: lib.price_rrp,
      price_trade: lib.price_trade,
      library_item_id: lib.id,
      created_by: createdBy,
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  // Usage tracking (best-effort, same as POST /api/projects/[id]/items).
  await supabase
    .from("library_items")
    .update({ usage_count: (lib.usage_count ?? 0) + 1 })
    .eq("id", lib.id);

  await supabase
    .from("project_library_items")
    .upsert(
      { project_id: projectId, library_item_id: lib.id },
      { onConflict: "project_id,library_item_id" }
    );

  await copyLibraryAssemblyComponentsToItem(
    supabase,
    lib.id,
    item.id,
    createdBy
  );

  return item;
}

/**
 * Copies every id in `libraryItemIds` onto `projectId`, best-effort —
 * one item's failure (e.g. a stale/deleted library id in the checklist
 * body) does not abort the rest. Used by both new "Standard spec
 * items" call sites (POST /api/projects, POST
 * /api/leads/[id]/create-project) right after the project row itself
 * is created. Returns the successfully-created items; failures are
 * silently skipped — project creation itself must never fail because
 * one optional standard item couldn't be copied.
 */
export async function copyStandardItems(
  supabase: SupabaseClient,
  projectId: string,
  libraryItemIds: string[],
  createdBy: string
) {
  const created = [];
  for (const id of libraryItemIds) {
    try {
      created.push(await copyLibraryItemToProject(supabase, projectId, id, createdBy));
    } catch {
      // Best-effort — see doc comment above.
    }
  }
  return created;
}
