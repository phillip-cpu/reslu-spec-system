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
    title?: unknown; scope?: unknown; requested_quote_date?: unknown; line_ids?: unknown; contact_ids?: unknown;
  };
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  const scope = typeof body?.scope === "string" && body.scope.trim() ? body.scope.trim() : null;
  const requestedQuoteDate = typeof body?.requested_quote_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.requested_quote_date) ? body.requested_quote_date : null;
  const lineIds = Array.isArray(body?.line_ids) ? [...new Set(body.line_ids.filter((id): id is string => typeof id === "string"))] : [];
  const contactIds = Array.isArray(body?.contact_ids) ? [...new Set(body.contact_ids.filter((id): id is string => typeof id === "string"))] : [];
  if (!title || lineIds.length === 0 || contactIds.length === 0) {
    return NextResponse.json({ error: "Title, at least one estimate line, and at least one supplier are required" }, { status: 400 });
  }

  const [{ data: lines }, { data: contacts }] = await Promise.all([
    supabase.from("cost_lines").select("id,project_id,description,qty,unit,sort").in("id", lineIds).eq("project_id", projectId).is("deleted_at", null),
    supabase.from("contacts").select("id,email").in("id", contactIds).is("deleted_at", null),
  ]);
  if ((lines ?? []).length !== lineIds.length) return NextResponse.json({ error: "One or more estimate lines are invalid" }, { status: 400 });
  if ((contacts ?? []).length !== contactIds.length) return NextResponse.json({ error: "One or more suppliers are invalid" }, { status: 400 });
  const missingEmail = (contacts ?? []).find((contact) => !contact.email);
  if (missingEmail) return NextResponse.json({ error: "Every selected supplier needs an email address" }, { status: 400 });

  const { data: quotePackage, error: packageError } = await supabase.from("supplier_quote_packages").insert({
    project_id: projectId,
    title,
    scope,
    requested_quote_date: requestedQuoteDate,
    created_by: info.userId,
  }).select().single();
  if (packageError || !quotePackage) return NextResponse.json({ error: packageError?.message ?? "Could not create quote package" }, { status: 500 });

  const acknowledgementDue = addBusinessDays(new Date(), 2);
  const [{ error: lineError }, { error: requestError }] = await Promise.all([
    supabase.from("supplier_quote_package_lines").insert((lines ?? []).map((line) => ({
      package_id: quotePackage.id,
      cost_line_id: line.id,
      description_snapshot: line.description,
      qty_snapshot: line.qty,
      unit_snapshot: line.unit,
      sort: line.sort,
    }))),
    supabase.from("supplier_quote_requests").insert((contacts ?? []).map((contact) => ({
      package_id: quotePackage.id,
      contact_id: contact.id,
      sent_to_email: contact.email,
      acknowledgement_due_at: acknowledgementDue,
      created_by: info.userId,
    }))),
  ]);
  if (lineError || requestError) {
    await supabase.from("supplier_quote_packages").delete().eq("id", quotePackage.id);
    return NextResponse.json({ error: lineError?.message ?? requestError?.message ?? "Could not create quote package" }, { status: 500 });
  }

  const packages = await loadSupplierQuotePackages(supabase, projectId);
  return NextResponse.json({ package: packages.find((row) => row.id === quotePackage.id) }, { status: 201 });
}
