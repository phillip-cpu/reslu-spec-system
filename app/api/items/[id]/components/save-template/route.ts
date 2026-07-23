import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: itemId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can save assembly templates" }, { status: 403 });
  }

  const { data: item } = await supabase
    .from("items")
    .select("*")
    .eq("id", itemId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  const { data: components } = await supabase
    .from("item_components")
    .select("*")
    .eq("item_id", itemId)
    .is("deleted_at", null)
    .order("sort");
  if (!components?.length) {
    return NextResponse.json({ error: "Add at least one component first" }, { status: 400 });
  }

  let parentLibraryId = item.library_item_id as string | null;
  if (!parentLibraryId) {
    const { data: libraryParent, error: parentError } = await supabase
      .from("library_items")
      .insert({
        name: item.name,
        description: item.description,
        supplier: item.supplier,
        supplier_email: item.supplier_email,
        brand: item.brand,
        category: item.category,
        location: item.location,
        application_note: item.application_note,
        colour: item.colour,
        material: item.material,
        finish: item.finish,
        width_mm: item.width_mm,
        height_mm: item.height_mm,
        length_mm: item.length_mm,
        depth_mm: item.depth_mm,
        product_url: item.product_url,
        default_image_url: item.selected_image_url,
        price_rrp: item.price_rrp,
        price_trade: item.price_trade,
        created_by: info.userId,
      })
      .select("id")
      .single();
    if (parentError || !libraryParent) {
      return NextResponse.json(
        { error: parentError?.message ?? "Could not create the parent library product" },
        { status: 500 }
      );
    }
    parentLibraryId = libraryParent.id;
    await supabase.from("items").update({ library_item_id: parentLibraryId }).eq("id", itemId);
    await supabase
      .from("project_library_items")
      .upsert(
        { project_id: item.project_id, library_item_id: parentLibraryId },
        { onConflict: "project_id,library_item_id" }
      );
  }

  const templateRows: Record<string, unknown>[] = [];
  for (const component of components) {
    let componentLibraryId = component.library_item_id as string | null;
    if (!componentLibraryId) {
      const { data: libraryComponent, error: componentError } = await supabase
        .from("library_items")
        .insert({
          name: component.name,
          supplier: component.supplier,
          supplier_email: component.supplier_email,
          brand: component.brand,
          category: item.category,
          finish: component.finish,
          product_url: component.product_url,
          price_trade: component.price_trade,
          trade_price_received_at: component.trade_price_received_at,
          trade_price_source: component.trade_price_source,
          created_by: info.userId,
        })
        .select("id")
        .single();
      if (componentError || !libraryComponent) {
        return NextResponse.json(
          { error: componentError?.message ?? `Could not save ${component.name} to the library` },
          { status: 500 }
        );
      }
      componentLibraryId = libraryComponent.id;
      await supabase
        .from("item_components")
        .update({ library_item_id: componentLibraryId })
        .eq("id", component.id);
    }

    templateRows.push({
      parent_library_item_id: parentLibraryId,
      component_library_item_id: componentLibraryId,
      name: component.name,
      supplier: component.supplier,
      supplier_email: component.supplier_email,
      brand: component.brand,
      supplier_item_code: component.supplier_item_code,
      quantity_per_item: component.quantity_per_item,
      unit: component.unit,
      price_trade: component.price_trade,
      finish: component.finish,
      product_url: component.product_url,
      lead_time_weeks: component.lead_time_weeks,
      sort: component.sort,
      created_by: info.userId,
    });
  }

  await supabase
    .from("library_item_components")
    .delete()
    .eq("parent_library_item_id", parentLibraryId);
  const { error: templateError } = await supabase
    .from("library_item_components")
    .insert(templateRows);
  if (templateError) {
    return NextResponse.json({ error: templateError.message }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    library_item_id: parentLibraryId,
    component_count: templateRows.length,
  });
}
