import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";

export interface SourceInvoiceAttachmentInput {
  invoiceId: string;
  emailAttachmentId: string;
}

export async function attachStuartSourceInvoice(input: SourceInvoiceAttachmentInput) {
  const service = createServiceRoleClient();
  const { data: invoice, error: invoiceError } = await service
    .from("invoices")
    .select("id,source_email_id,storage_path,status")
    .eq("id", input.invoiceId)
    .single();
  if (invoiceError || !invoice) throw new Error(invoiceError?.message ?? "Supplier invoice was not found");
  if (!invoice.source_email_id) throw new Error("The Spec invoice has no traceable source email");
  if (["rejected", "voided"].includes(invoice.status)) throw new Error("Rejected or voided invoices cannot receive source evidence");

  const { data: attachment, error: attachmentError } = await service
    .from("email_attachments")
    .select("id,email_id,filename,mime,storage_ref,content_sha256,extracted_text")
    .eq("id", input.emailAttachmentId)
    .single();
  if (attachmentError || !attachment) throw new Error(attachmentError?.message ?? "Email attachment was not found");
  if (attachment.email_id !== invoice.source_email_id) throw new Error("Attachment does not belong to the invoice's traceable source email");
  if (attachment.mime !== "application/pdf" || !attachment.storage_ref) throw new Error("The original supplier invoice must be a stored PDF");
  if (!/^[a-f0-9]{64}$/i.test(attachment.content_sha256 ?? "")) throw new Error("The source PDF has no verified content fingerprint");
  if (!attachment.extracted_text?.trim()) throw new Error("The source PDF must have readable extracted evidence before attachment");
  if (invoice.storage_path && invoice.storage_path !== attachment.storage_ref) {
    throw new Error("This Spec invoice already has different source evidence; a human must resolve the conflict");
  }

  const { data: sourceFile, error: sourceError } = await service.storage.from(ASSET_BUCKET).download(attachment.storage_ref);
  if (sourceError || !sourceFile || sourceFile.size === 0) throw new Error("The stored source PDF could not be verified");

  if (!invoice.storage_path) {
    const { error: updateError } = await service
      .from("invoices")
      .update({ storage_path: attachment.storage_ref })
      .eq("id", invoice.id)
      .is("storage_path", null);
    if (updateError) throw new Error(`Source evidence could not be attached: ${updateError.message}`);
  }

  return {
    invoice_id: invoice.id,
    email_attachment_id: attachment.id,
    filename: attachment.filename,
    content_sha256: attachment.content_sha256,
    status: "attached" as const,
    human_action: "Verify the invoice date, line items and total against the attached PDF before approving a Xero draft.",
  };
}
