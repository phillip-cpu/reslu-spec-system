import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getUserRole } from "@/lib/auth";
import type { ItemComponent, PatchItemComponentInput } from "@/types/item-components";

const TEXT_FIELDS = new Set([
  "name",
  "supplier",
  "supplier_email",
  "brand",
  "supplier_item_code",
  "unit",
  "finish",
  "product_url",
]);
const NUMBER_FIELDS = new Set(["quantity_per_item", "price_trade", "lead_time_weeks"]);
const DATE_FIELDS = new Set(["ordered_at", "eta", "delivered_at"]);

async function parentPrice(supabase: Awaited<ReturnType<typeof createClient>>, itemId: string) {
  const { data } = await supabase.from("items").select("price_trade").eq("id", itemId).single();
  return data?.price_trade === null || data?.price_trade === undefined
    ? null
    : Number(data.price_trade);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit assembly pricing" }, { status: 403 });
  }

  const body = (await request.json().catch(() => null)) as PatchItemComponentInput | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  const update: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(body)) {
    if (TEXT_FIELDS.has(key)) {
      update[key] = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    } else if (DATE_FIELDS.has(key)) {
      update[key] = typeof raw === "string" && raw ? raw : null;
    } else if (NUMBER_FIELDS.has(key)) {
      if (raw === "" || raw === null) {
        update[key] = null;
      } else {
        const number = Number(raw);
        if (!Number.isFinite(number)) {
          return NextResponse.json({ error: `${key} must be a number` }, { status: 400 });
        }
        if (key === "quantity_per_item" && number <= 0) {
          return NextResponse.json(
            { error: "Quantity per item must be greater than zero" },
            { status: 400 }
          );
        }
        if (key !== "quantity_per_item" && number < 0) {
          return NextResponse.json({ error: `${key} cannot be negative` }, { status: 400 });
        }
        update[key] = number;
      }
    }
  }
  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }
  if (update.name === null) {
    return NextResponse.json({ error: "Component name is required" }, { status: 400 });
  }

  const { data: existing } = await supabase
    .from("item_components")
    .select("item_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Component not found" }, { status: 404 });

  if ("price_trade" in update) {
    update.trade_price_received_at =
      update.price_trade === null ? null : new Date().toISOString().slice(0, 10);
    update.trade_price_source = update.price_trade === null ? null : "Manual component price";
  }

  const { data: component, error } = await supabase
    .from("item_components")
    .update(update)
    .eq("id", id)
    .select()
    .single();
  if (error) {
    const status = error.code === "23514" ? 400 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({
    component: component as ItemComponent,
    parent_price_trade: await parentPrice(supabase, existing.item_id),
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") {
    return NextResponse.json({ error: "Only admins can edit assembly pricing" }, { status: 403 });
  }

  const { data: existing } = await supabase
    .from("item_components")
    .select("item_id")
    .eq("id", id)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "Component not found" }, { status: 404 });

  const { error } = await supabase
    .from("item_components")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    ok: true,
    parent_price_trade: await parentPrice(supabase, existing.item_id),
  });
}
