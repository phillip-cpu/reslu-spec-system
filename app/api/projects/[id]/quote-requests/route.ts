import { NextRequest, NextResponse } from "next/server";
import { getUserRole } from "@/lib/auth";
import { loadSupplierQuotePackages } from "@/lib/supplier-quote-server";
import { createClient } from "@/lib/supabase/server";

function addBusinessDays(date: Date, days: number): string {
  const result = new Date(date);
  let remaining = days;
  while (remaining > 0) {
    result.setDate(result.getDate() + 1);
    if (result.getDay() !== 0 && result.getDay() !== 6) remaining -= 1;
  }
  return result.toISOString().slice(0, 10);
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can view quote requests" }, { status: 403 });
  try {
    return NextResponse.json({ packages: await loadSupplierQuotePackages(supabase, projectId) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load quote requests" }, { status: 500 });
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createClient();
  const info = await getUserRole(supabase);
  if (!info) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (info.role !== "admin") return NextResponse.json({ error: "Only admins can create quote requests" }, { status: 403 });

  const body = await request.json().catch(() => null) as null | {
    title?: unknown;
    scope?: unknown;
    requested_quote_date?: unknown;
    line_ids?: unknown;
    item_ids?: unknown;
    contact_ids?: unknown;
    source?: unknown;
    manual_response?: unknown;
  };
  const source = body?.source === "manual" ? "manual" : "request";
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const scope = typeof body?.scope === "string" && body.scope.trim() ? body.scope.trim() : null;
  const requestedQuoteDate = typeof body?.requested_quote_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.requested_quote_date) ? body.requested_quote_date : null;
  const lineIds = Array.isArray(body?.line_ids) ? [...new Set(body.line_ids.filter((id): id is string => typeof id === "string"))] : [];
  const itemIds = Array.isArray(body?.item_ids) ? [...new Set(body.item_ids.filter((id): id is string => typeof id === "string"))] : [];
  const contactIds = Array.isArray(body?.contact_ids) ? [...new Set(body.contact_ids.filter((id): id is string => typeof id === "string"))] : [];
  if (!title || lineIds.length + itemIds.length === 0 || contactIds.length === 0) {
    return NextResponse.json({ error: "Title, at least one estimate line or direct FF&E item, and at least one supplier are required" }, { status: 400 });
  }
  if (source === "manual" && contactIds.length !== 1) {
    return NextResponse.json({ error: "A received quote must be linked to one supplier" }, { status: 400 });
  }

  const manualResponse = body?.manual_response && typeof body.manual_response === "object"
    ? body.manual_response as Record<string, unknown>
    : {};
  const manualLineAmounts = manualResponse.line_amounts && typeof manualResponse.line_amounts === "object"
    ? manualResponse.line_amounts as Record<string, unknown>
    : {};
  const manualItemAmounts = manualResponse.item_amounts && typeof manualResponse.item_amounts === "object"
    ? manualResponse.item_amounts as Record<string, unknown>
    : {};
  if (source === "manual") {
    for (const [id, amount] of [...lineIds.map((id) => [id, manualLineAmounts[id]] as const), ...itemIds.map((id) => [id, manualItemAmounts[id]] as const)]) {
      if (amount !== null && amount !== undefined && (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)) {
        return NextResponse.json({ error: `Quote amount for ${id} must be a non-negative number` }, { status: 400 });
      }
    }
  }

  const [{ data: lines }, { data: items }, { data: contacts }] = await Promise.all([
    lineIds.length
      ? supabase.from("cost_lines").select("id,project_id,description,qty,unit,sort").in("id", lineIds).eq("project_id", projectId).is("deleted_at", null)
      : Promise.resolve({ data: [] as { id: string; project_id: string; description: string; qty: number | null; unit: string | null; sort: number }[] }),
    itemIds.length
      ? supabase.from("items").select("id,project_id,item_code,name,quantity,unit,cost_scope").in("id", itemIds).eq("project_id", projectId).is("deleted_at", null).neq("cost_scope", "trade_package")
      : Promise.resolve({ data: [] as { id: string; project_id: string; item_code: string; name: string; quantity: number | null; unit: string | null; cost_scope: string }[] }),
    supabase.from("contacts").select("id,email").in("id", contactIds).is("deleted_at", null),
  ]);
  if ((lines ?? []).length !== lineIds.length) return NextResponse.json({ error: "One or more estimate lines are invalid" }, { status: 400 });
  if ((items ?? []).length !== itemIds.length) return NextResponse.json({ error: "One or more FF&E items are invalid or included in a trade package" }, { status: 400 });
  if ((contacts ?? []).length !== contactIds.length) return NextResponse.json({ error: "One or more suppliers are invalid" }, { status: 400 });
  const missingEmail = source === "request" ? (contacts ?? []).find((contact) => !contact.email) : null;
  if (missingEmail) return NextResponse.json({ error: "Every selected supplier needs an email address" }, { status: 400 });

  const now = new Date().toISOString();
  const { data: quotePackage, error: packageError } = await supabase.from("supplier_quote_packages").insert({
    project_id: projectId,
    title,
    scope,
    requested_quote_date: requestedQuoteDate,
    ...(source === "manual" ? { status: "sent", sent_at: now } : {}),
    created_by: info.userId,
  }).select().single();
  if (packageError || !quotePackage) return NextResponse.json({ error: packageError?.message ?? "Could not create quote package" }, { status: 500 });

  const acknowledgementDue = addBusinessDays(new Date(), 2);
  const [lineWrite, itemWrite, requestWrite] = await Promise.all([
    lines?.length ? supabase.from("supplier_quote_package_lines").insert(lines.map((line) => ({
      package_id: quotePackage.id,
      cost_line_id: line.id,
      description_snapshot: line.description,
      qty_snapshot: line.qty,
      unit_snapshot: line.unit,
      sort: line.sort,
    }))).select("id,cost_line_id") : Promise.resolve({ data: [] as { id: string; cost_line_id: string }[], error: null }),
    items?.length ? supabase.from("supplier_quote_package_items").insert(items.map((item, index) => ({
      package_id: quotePackage.id,
      item_id: item.id,
      item_code_snapshot: item.item_code,
      description_snapshot: item.name,
      qty_snapshot: item.quantity,
      unit_snapshot: item.unit,
      sort: index + 1,
    }))).select("id,item_id") : Promise.resolve({ data: [] as { id: string; item_id: string }[], error: null }),
    supabase.from("supplier_quote_requests").insert((contacts ?? []).map((contact) => ({
      package_id: quotePackage.id,
      contact_id: contact.id,
      sent_to_email: contact.email,
      acknowledgement_due_at: source === "request" ? acknowledgementDue : null,
      ...(source === "manual" ? {
        status: "quote_received",
        acknowledged_at: now,
        quote_received_at: now,
        quote_reference: typeof manualResponse.quote_reference === "string" ? manualResponse.quote_reference.trim() || null : null,
        response_note: typeof manualResponse.response_note === "string" ? manualResponse.response_note.trim() || null : null,
      } : {}),
      created_by: info.userId,
    }))).select("id,contact_id"),
  ]);
  const lineError = lineWrite.error;
  const itemError = itemWrite.error;
  const requestError = requestWrite.error;
  if (lineError || itemError || requestError) {
    await supabase.from("supplier_quote_packages").delete().eq("id", quotePackage.id);
    return NextResponse.json({ error: lineError?.message ?? itemError?.message ?? requestError?.message ?? "Could not create quote package" }, { status: 500 });
  }

  if (source === "manual") {
    const quoteRequest = requestWrite.data?.[0];
    if (!quoteRequest) {
      await supabase.from("supplier_quote_packages").delete().eq("id", quotePackage.id);
      return NextResponse.json({ error: "Could not create the received quote record" }, { status: 500 });
    }
    const lineAmountRows = (lineWrite.data ?? []).map((packageLine) => ({
      request_id: quoteRequest.id,
      package_line_id: packageLine.id,
      amount_ex_gst: typeof manualLineAmounts[packageLine.cost_line_id] === "number" ? manualLineAmounts[packageLine.cost_line_id] as number : null,
    }));
    const itemAmountRows = (itemWrite.data ?? []).map((packageItem) => ({
      request_id: quoteRequest.id,
      package_item_id: packageItem.id,
      amount_ex_gst: typeof manualItemAmounts[packageItem.item_id] === "number" ? manualItemAmounts[packageItem.item_id] as number : null,
    }));
    const [lineResponseWrite, itemResponseWrite] = await Promise.all([
      lineAmountRows.length ? supabase.from("supplier_quote_response_lines").insert(lineAmountRows) : Promise.resolve({ error: null }),
      itemAmountRows.length ? supabase.from("supplier_quote_response_items").insert(itemAmountRows) : Promise.resolve({ error: null }),
    ]);
    const responseError = lineResponseWrite.error ?? itemResponseWrite.error;
    if (responseError) {
      await supabase.from("supplier_quote_packages").delete().eq("id", quotePackage.id);
      return NextResponse.json({ error: responseError.message }, { status: 500 });
    }
    const enteredAmounts = [...lineAmountRows, ...itemAmountRows]
      .map((row) => row.amount_ex_gst)
      .filter((amount): amount is number => typeof amount === "number");
    if (enteredAmounts.length > 0) {
      const { error: totalError } = await supabase
        .from("supplier_quote_requests")
        .update({ quote_amount_ex_gst: enteredAmounts.reduce((sum, amount) => sum + amount, 0) })
        .eq("id", quoteRequest.id);
      if (totalError) {
        await supabase.from("supplier_quote_packages").delete().eq("id", quotePackage.id);
        return NextResponse.json({ error: totalError.message }, { status: 500 });
      }
    }
    if (lineIds.length > 0) await supabase.from("cost_lines").update({ quote_status: "Q" }).in("id", lineIds);
  }

  const packages = await loadSupplierQuotePackages(supabase, projectId);
  return NextResponse.json({ package: packages.find((row) => row.id === quotePackage.id) }, { status: 201 });
}
