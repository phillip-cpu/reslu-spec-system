import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { CreateItemComponentInput, ItemComponent } from "@/types/item-components";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null | undefined {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function parentPrice(supabase: Awaited<ReturnType<typeof createClient>>, itemId: string) {
  const { data } = await supabase.from("items").select("price_trade").eq("id", itemId).single();
  return data?.price_trade === null || data?.price_trade === undefined
    ? null
    : Number(data.price_trade);
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: itemId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can access assembly pricing" }, { status: 403 });
  }

  const { data, error } = await supabase
    .from("item_components")
    .select("*")
    .eq("item_id", itemId)
    .is("deleted_at", null)
    .order("sort", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ components: (data ?? []) as ItemComponent[] });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: itemId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit assembly pricing" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as CreateItemComponentInput | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });

  const { data: item } = await supabase
    .from("items")
    .select("id")
    .eq("id", itemId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });

  let libraryDefaults: Record<string, unknown> = {};
  if (body.library_item_id) {
    const { data: libraryItem } = await supabase
      .from("library_items")
      .select("*")
      .eq("id", body.library_item_id)
      .maybeSingle();
    if (!libraryItem) {
      return NextResponse.json({ error: "Library component not found" }, { status: 400 });
    }
    libraryDefaults = {
      name: libraryItem.name,
      supplier: libraryItem.supplier,
      supplier_email: libraryItem.supplier_email,
      brand: libraryItem.brand,
      price_trade: libraryItem.price_trade,
      finish: libraryItem.finish,
      product_url: libraryItem.product_url,
      trade_price_received_at: libraryItem.trade_price_received_at,
      trade_price_source: libraryItem.trade_price_source,
    };
  }

  const name = text(body.name) ?? (libraryDefaults.name as string | null);
  if (!name) return NextResponse.json({ error: "Component name is required" }, { status: 400 });

  const quantity = optionalNumber(body.quantity_per_item);
  if (quantity === undefined || (quantity !== null && quantity <= 0)) {
    return NextResponse.json({ error: "Quantity per item must be greater than zero" }, { status: 400 });
  }
  const price = optionalNumber(body.price_trade);
  if (price === undefined || (price !== null && price < 0)) {
    return NextResponse.json({ error: "Trade price must be zero or greater" }, { status: 400 });
  }
  const leadTime = optionalNumber(body.lead_time_weeks);
  if (leadTime === undefined || (leadTime !== null && leadTime < 0)) {
    return NextResponse.json({ error: "Lead time must be zero or greater" }, { status: 400 });
  }

  const { count } = await supabase
    .from("item_components")
    .select("id", { count: "exact", head: true })
    .eq("item_id", itemId)
    .is("deleted_at", null);

  const { data: component, error } = await supabase
    .from("item_components")
    .insert({
      item_id: itemId,
      library_item_id: body.library_item_id ?? null,
      name,
      supplier: text(body.supplier) ?? (libraryDefaults.supplier as string | null) ?? null,
      supplier_email:
        text(body.supplier_email) ?? (libraryDefaults.supplier_email as string | null) ?? null,
      brand: text(body.brand) ?? (libraryDefaults.brand as string | null) ?? null,
      supplier_item_code: text(body.supplier_item_code),
      quantity_per_item: quantity ?? 1,
      unit: text(body.unit) ?? "ea",
      price_trade:
        price ?? (libraryDefaults.price_trade as number | null | undefined) ?? null,
      finish: text(body.finish) ?? (libraryDefaults.finish as string | null) ?? null,
      product_url: text(body.product_url) ?? (libraryDefaults.product_url as string | null) ?? null,
      lead_time_weeks: leadTime,
      trade_price_received_at:
        (libraryDefaults.trade_price_received_at as string | null | undefined) ?? null,
      trade_price_source:
        (libraryDefaults.trade_price_source as string | null | undefined) ?? null,
      sort: count ?? 0,
      created_by: info.userId,
    })
    .select()
    .single();

  if (error) {
    const status = error.code === "23503" || error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json(
    {
      component: component as ItemComponent,
      parent_price_trade: await parentPrice(supabase, itemId),
    },
    { status: 201 }
  );
}
