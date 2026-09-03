import type { SupabaseClient } from "@supabase/supabase-js";
import { ASSET_BUCKET, SIGNED_URL_TTL_SECONDS } from "@/lib/storage";
import type {
  SupplierQuoteAttachment,
  SupplierQuoteEmail,
  SupplierQuotePackage,
  SupplierQuoteRequest,
} from "@/types/supplier-quotes";

export async function loadSupplierQuotePackages(
  supabase: SupabaseClient,
  projectId: string
): Promise<SupplierQuotePackage[]> {
  const { data: packageRows, error } = await supabase
    .from("supplier_quote_packages")
    .select("*")
    .eq("project_id", projectId)
    .is("deleted_at", null)
    .order("created_at", { ascending: false });
  if (error) throw error;
  const packageIds = (packageRows ?? []).map((row) => row.id);
  if (packageIds.length === 0) return [];

  const [{ data: lineRows }, { data: itemRows }, { data: requestRows }, { data: attachmentRows }] = await Promise.all([
    supabase.from("supplier_quote_package_lines").select("*").in("package_id", packageIds).order("sort"),
    supabase.from("supplier_quote_package_items").select("*").in("package_id", packageIds).order("sort"),
    supabase.from("supplier_quote_requests").select("*").in("package_id", packageIds).order("created_at"),
    supabase.from("supplier_quote_attachments").select("*").in("package_id", packageIds).order("sort"),
  ]);

  const contactIds = [...new Set((requestRows ?? []).map((row) => row.contact_id).filter(Boolean))] as string[];
  const requestIds = (requestRows ?? []).map((row) => row.id);
  const [{ data: contacts }, { data: emailLinks }, { data: responseLines }, { data: responseItems }] = await Promise.all([
    contactIds.length
      ? supabase.from("contacts").select("id,company,contact_name,email").in("id", contactIds)
      : Promise.resolve({ data: [] as { id: string; company: string; contact_name: string | null; email: string | null }[] }),
    requestIds.length
      ? supabase.from("supplier_quote_request_emails").select("request_id,email_id").in("request_id", requestIds)
      : Promise.resolve({ data: [] as { request_id: string; email_id: string }[] }),
    requestIds.length
      ? supabase.from("supplier_quote_response_lines").select("request_id,package_line_id,amount_ex_gst,note").in("request_id", requestIds)
      : Promise.resolve({ data: [] as { request_id: string; package_line_id: string; amount_ex_gst: number | null; note: string | null }[] }),
    requestIds.length
      ? supabase.from("supplier_quote_response_items").select("request_id,package_item_id,amount_ex_gst,note").in("request_id", requestIds)
      : Promise.resolve({ data: [] as { request_id: string; package_item_id: string; amount_ex_gst: number | null; note: string | null }[] }),
  ]);

  const emailIds = [...new Set((emailLinks ?? []).map((row) => row.email_id))];
  const [{ data: emails }, { data: emailAttachments }] = await Promise.all([
    emailIds.length
      ? supabase.from("emails").select("id,direction,from_addr,subject,received_at,clean_text").in("id", emailIds).order("received_at")
      : Promise.resolve({ data: [] as Omit<SupplierQuoteEmail, "attachments">[] }),
    emailIds.length
      ? supabase.from("email_attachments").select("id,email_id,filename,mime").in("email_id", emailIds)
      : Promise.resolve({ data: [] as { id: string; email_id: string; filename: string | null; mime: string | null }[] }),
  ]);

  const emailAttachmentsByEmail = new Map<string, SupplierQuoteEmail["attachments"]>();
  for (const row of emailAttachments ?? []) {
    const list = emailAttachmentsByEmail.get(row.email_id) ?? [];
    list.push({ id: row.id, filename: row.filename, mime: row.mime });
    emailAttachmentsByEmail.set(row.email_id, list);
  }
  const emailById = new Map<string, SupplierQuoteEmail>();
  for (const email of emails ?? []) {
    emailById.set(email.id, { ...email, attachments: emailAttachmentsByEmail.get(email.id) ?? [] } as SupplierQuoteEmail);
  }
  const emailIdsByRequest = new Map<string, string[]>();
  for (const link of emailLinks ?? []) {
    const list = emailIdsByRequest.get(link.request_id) ?? [];
    list.push(link.email_id);
    emailIdsByRequest.set(link.request_id, list);
  }

  const contactById = new Map((contacts ?? []).map((row) => [row.id, row]));
  const responseLinesByRequest = new Map<string, { package_line_id: string; amount_ex_gst: number | null; note: string | null }[]>();
  for (const row of responseLines ?? []) {
    const list = responseLinesByRequest.get(row.request_id) ?? [];
    list.push({ package_line_id: row.package_line_id, amount_ex_gst: row.amount_ex_gst, note: row.note });
    responseLinesByRequest.set(row.request_id, list);
  }
  const responseItemsByRequest = new Map<string, { package_item_id: string; amount_ex_gst: number | null; note: string | null }[]>();
  for (const row of responseItems ?? []) {
    const list = responseItemsByRequest.get(row.request_id) ?? [];
    list.push({ package_item_id: row.package_item_id, amount_ex_gst: row.amount_ex_gst, note: row.note });
    responseItemsByRequest.set(row.request_id, list);
  }
  const requestByPackage = new Map<string, SupplierQuoteRequest[]>();
  for (const row of requestRows ?? []) {
    const request = {
      ...row,
      contact: row.contact_id ? contactById.get(row.contact_id) ?? null : null,
      emails: (emailIdsByRequest.get(row.id) ?? []).map((id) => emailById.get(id)).filter(Boolean),
      response_lines: responseLinesByRequest.get(row.id) ?? [],
      response_items: responseItemsByRequest.get(row.id) ?? [],
    } as SupplierQuoteRequest;
    const list = requestByPackage.get(row.package_id) ?? [];
    list.push(request);
    requestByPackage.set(row.package_id, list);
  }

  const linesByPackage = new Map<string, typeof lineRows>();
  for (const row of lineRows ?? []) {
    const list = linesByPackage.get(row.package_id) ?? [];
    list.push(row);
    linesByPackage.set(row.package_id, list);
  }
  const itemsByPackage = new Map<string, typeof itemRows>();
  for (const row of itemRows ?? []) {
    const list = itemsByPackage.get(row.package_id) ?? [];
    list.push(row);
    itemsByPackage.set(row.package_id, list);
  }

  const attachmentsByPackage = new Map<string, SupplierQuoteAttachment[]>();
  for (const row of attachmentRows ?? []) {
    const { data: signed } = await supabase.storage.from(ASSET_BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);
    const attachment = { ...row, url: signed?.signedUrl ?? null } as SupplierQuoteAttachment;
    const list = attachmentsByPackage.get(row.package_id) ?? [];
    list.push(attachment);
    attachmentsByPackage.set(row.package_id, list);
  }

  return (packageRows ?? []).map((row) => ({
    ...row,
    lines: linesByPackage.get(row.id) ?? [],
    items: itemsByPackage.get(row.id) ?? [],
    requests: requestByPackage.get(row.id) ?? [],
    attachments: attachmentsByPackage.get(row.id) ?? [],
  })) as SupplierQuotePackage[];
}
