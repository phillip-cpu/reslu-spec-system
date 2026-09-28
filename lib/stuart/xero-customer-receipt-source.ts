import { createServiceRoleClient } from "@/lib/supabase/server";
import { ASSET_BUCKET } from "@/lib/storage";
import { verifiedRemittanceHash } from "./customer-receipt-contract";

export async function loadCustomerRemittanceSource(emailId: string, attachmentId: string, expectedHash?: string) {
  const service = createServiceRoleClient();
  const { data: email, error: emailError } = await service.from("emails").select("id,ingested_mailboxes").eq("id", emailId).maybeSingle();
  if (emailError || !email || !Array.isArray(email.ingested_mailboxes)
    || !email.ingested_mailboxes.some((mailbox: unknown) => typeof mailbox === "string" && mailbox.trim().toLowerCase() === "accounts@reslu.com.au")) {
    throw new Error("The remittance must come from a verified Accounts mailbox email");
  }
  const { data: attachment, error } = await service.from("email_attachments")
    .select("id,email_id,filename,mime,storage_ref,content_sha256").eq("id", attachmentId).maybeSingle();
  if (error || !attachment || attachment.email_id !== emailId || attachment.mime !== "application/pdf" || !attachment.storage_ref
    || !/^[a-f0-9]{64}$/.test(attachment.content_sha256 ?? "") || (expectedHash != null && attachment.content_sha256 !== expectedHash)) throw new Error("The original remittance attachment does not match the exact email and source hash");
  const { data: file, error: downloadError } = await service.storage.from(ASSET_BUCKET).download(attachment.storage_ref);
  if (downloadError || !file || file.size < 8 || file.size > 20 * 1024 * 1024) throw new Error("The original remittance PDF is unavailable or exceeds 20 MB");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sha256 = verifiedRemittanceHash(bytes, attachment.content_sha256, expectedHash);
  return { sha256, filename: String(attachment.filename ?? "remittance.pdf") };
}
