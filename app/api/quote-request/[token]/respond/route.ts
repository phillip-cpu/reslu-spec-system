import { NextRequest, NextResponse } from "next/server";
import { isSniffedImage, validateUploadBytes } from "@/lib/file-sniff";
import { rateLimit } from "@/lib/rate-limit";
import { ASSET_BUCKET, slugFilename } from "@/lib/storage";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

export async function POST(request: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const clientIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!rateLimit(`supplier-quote-response:${token}:${clientIp}`, 10, 60_000).ok) return NextResponse.json({ error: "Too many attempts" }, { status: 429 });
  const supabase = createServiceRoleClient();
  const { data: quoteRequest } = await supabase.from("supplier_quote_requests").select("*").eq("token", token).maybeSingle();
  if (!quoteRequest) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (["declined", "selected", "closed"].includes(quoteRequest.status)) return NextResponse.json({ error: "This request is closed" }, { status: 409 });

  const form = await request.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Expected form data" }, { status: 400 });
  const action = String(form.get("action") ?? "");
  const note = String(form.get("note") ?? "").trim() || null;
  const now = new Date().toISOString();

  if (action === "turnaround") {
    const promised = String(form.get("expected_quote_date") ?? "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(promised)) return NextResponse.json({ error: "Please choose an expected quote date" }, { status: 400 });
    await supabase.from("supplier_quote_requests").update({ status: "acknowledged", acknowledged_at: quoteRequest.acknowledged_at ?? now, promised_quote_at: promised, response_note: note }).eq("id", quoteRequest.id);
    return NextResponse.json({ ok: true });
  }
  if (action === "decline") {
    await supabase.from("supplier_quote_requests").update({ status: "declined", acknowledged_at: quoteRequest.acknowledged_at ?? now, response_note: note }).eq("id", quoteRequest.id);
    return NextResponse.json({ ok: true });
  }
  if (action !== "quote") return NextResponse.json({ error: "Invalid response" }, { status: 400 });

  const [{ data: packageLines, error: packageLineError }, { data: packageItems, error: packageItemError }] = await Promise.all([
    supabase.from("supplier_quote_package_lines").select("id").eq("package_id", quoteRequest.package_id),
    supabase.from("supplier_quote_package_items").select("id").eq("package_id", quoteRequest.package_id),
  ]);
  const packageTargetError = packageLineError ?? packageItemError;
  if (packageTargetError) return NextResponse.json({ error: packageTargetError.message }, { status: 500 });
  const responseLines = [];
  for (const line of packageLines ?? []) {
    const raw = String(form.get(`line_amount_${line.id}`) ?? "");
    if (!raw.trim()) return NextResponse.json({ error: "Enter an amount for every line" }, { status: 400 });
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "Enter a valid amount for every line" }, { status: 400 });
    responseLines.push({ request_id: quoteRequest.id, package_line_id: line.id, amount_ex_gst: amount });
  }
  const responseItems = [];
  for (const item of packageItems ?? []) {
    const raw = String(form.get(`item_amount_${item.id}`) ?? "");
    if (!raw.trim()) return NextResponse.json({ error: "Enter an amount for every FF&E item" }, { status: 400 });
    const amount = Number(raw);
    if (!Number.isFinite(amount) || amount < 0) return NextResponse.json({ error: "Enter a valid amount for every FF&E item" }, { status: 400 });
    responseItems.push({ request_id: quoteRequest.id, package_item_id: item.id, amount_ex_gst: amount });
  }
  if (responseLines.length + responseItems.length === 0) return NextResponse.json({ error: "This quote request has no items" }, { status: 400 });
  const total = [...responseLines, ...responseItems].reduce((sum, item) => sum + item.amount_ex_gst, 0);
  const [responseLineWrite, responseItemWrite] = await Promise.all([
    responseLines.length ? supabase.from("supplier_quote_response_lines").upsert(responseLines, { onConflict: "request_id,package_line_id" }) : Promise.resolve({ error: null }),
    responseItems.length ? supabase.from("supplier_quote_response_items").upsert(responseItems, { onConflict: "request_id,package_item_id" }) : Promise.resolve({ error: null }),
  ]);
  const responseError = responseLineWrite.error ?? responseItemWrite.error;
  if (responseError) return NextResponse.json({ error: responseError.message }, { status: 500 });

  const files = form.getAll("files").filter((value): value is File => value instanceof File && value.size > 0);
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) return NextResponse.json({ error: `${file.name} is larger than 20 MB` }, { status: 400 });
    const bytes = Buffer.from(await file.arrayBuffer());
    const validation = validateUploadBytes(bytes, file.type || "");
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });
    if (file.type.startsWith("image/") && !isSniffedImage(bytes)) return NextResponse.json({ error: `${file.name} is not a valid image` }, { status: 400 });
    const path = `quote-responses/${quoteRequest.id}/${Date.now()}-${crypto.randomUUID()}-${slugFilename(file.name || "attachment")}`;
    const { error: uploadError } = await supabase.storage.from(ASSET_BUCKET).upload(path, bytes, { contentType: file.type || "application/octet-stream", upsert: false });
    if (uploadError) return NextResponse.json({ error: uploadError.message }, { status: 500 });
    const { error: insertError } = await supabase.from("supplier_quote_attachments").insert({ package_id: quoteRequest.package_id, request_id: quoteRequest.id, kind: "response", storage_path: path, filename: file.name || "attachment", mime: file.type || null, byte_size: file.size });
    if (insertError) {
      await supabase.storage.from(ASSET_BUCKET).remove([path]);
      return NextResponse.json({ error: insertError.message }, { status: 500 });
    }
  }

  await supabase.from("supplier_quote_requests").update({ status: "quote_received", acknowledged_at: quoteRequest.acknowledged_at ?? now, quote_received_at: now, quote_amount_ex_gst: total, quote_reference: String(form.get("quote_reference") ?? "").trim() || null, response_note: note }).eq("id", quoteRequest.id);
  const { data: linkedLines } = await supabase.from("supplier_quote_package_lines").select("cost_line_id").eq("package_id", quoteRequest.package_id);
  if (linkedLines?.length) await supabase.from("cost_lines").update({ quote_status: "Q" }).in("id", linkedLines.map((line) => line.cost_line_id));
  return NextResponse.json({ ok: true });
}
