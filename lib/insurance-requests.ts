import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  InsuranceRequestKind,
  InsuranceRequestPortalData,
  InsuranceRequestStatus,
} from "@/types/insurance-requests";

export const INSURANCE_REQUEST_KINDS: InsuranceRequestKind[] = [
  "public_liability",
  "professional_indemnity",
  "workers_comp",
  "licence",
];

export const INSURANCE_REQUEST_KIND_LABEL: Record<InsuranceRequestKind, string> = {
  public_liability: "Public liability insurance",
  professional_indemnity: "Professional indemnity insurance",
  workers_comp: "Workers compensation insurance",
  licence: "Trade licence",
};

export function normaliseInsuranceRequestKinds(input: unknown): InsuranceRequestKind[] {
  if (!Array.isArray(input)) return ["public_liability", "workers_comp"];
  const result: InsuranceRequestKind[] = [];
  for (const value of input) {
    if (
      typeof value === "string" &&
      INSURANCE_REQUEST_KINDS.includes(value as InsuranceRequestKind) &&
      !result.includes(value as InsuranceRequestKind)
    ) {
      result.push(value as InsuranceRequestKind);
    }
  }
  return result;
}

export function allRequestedKindsUploaded(
  requestedKinds: InsuranceRequestKind[],
  uploadedKinds: InsuranceRequestKind[]
): boolean {
  return (
    requestedKinds.length > 0 &&
    requestedKinds.every((kind) => uploadedKinds.includes(kind))
  );
}

export function isInsuranceRequestAvailable(
  status: InsuranceRequestStatus,
  expiresAt: string,
  now: Date = new Date()
): boolean {
  if (status === "completed" || status === "cancelled") return false;
  const expiry = new Date(expiresAt);
  return !Number.isNaN(expiry.getTime()) && expiry.getTime() > now.getTime();
}

export function escapeEmailHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderInsuranceRequestEmail(input: {
  greetingName: string;
  company: string;
  kinds: InsuranceRequestKind[];
  uploadUrl: string;
  expiresLabel: string;
}): string {
  const greetingName = escapeEmailHtml(input.greetingName);
  const company = escapeEmailHtml(input.company);
  const uploadUrl = escapeEmailHtml(input.uploadUrl);
  const expiresLabel = escapeEmailHtml(input.expiresLabel);
  const list = input.kinds
    .map((kind) => `<li style="margin:0 0 8px">${escapeEmailHtml(INSURANCE_REQUEST_KIND_LABEL[kind])}</li>`)
    .join("");

  return `<!doctype html>
<html>
  <body style="margin:0;background:#f4efe5;color:#202020;font-family:Arial,Helvetica,sans-serif">
    <div style="max-width:620px;margin:0 auto;padding:44px 24px">
      <div style="font-size:28px;letter-spacing:10px;margin-bottom:42px">RESLU</div>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px">Hi ${greetingName},</p>
      <p style="font-size:16px;line-height:1.7;margin:0 0 18px">
        We’re updating our trade records for ${company}. Please upload the following current documents:
      </p>
      <ul style="font-size:16px;line-height:1.6;padding-left:20px;margin:0 0 28px">${list}</ul>
      <p style="margin:0 0 30px">
        <a href="${uploadUrl}" style="display:inline-block;background:#202020;color:#ffffff;text-decoration:none;padding:14px 22px;font-size:14px;letter-spacing:1px">
          UPLOAD DOCUMENTS
        </a>
      </p>
      <p style="font-size:13px;line-height:1.6;color:#6f6a61;margin:0 0 28px">
        The secure link is available until ${expiresLabel}. It can be opened on your phone and does not require a login.
      </p>
      <p style="font-size:14px;line-height:1.6;margin:0">
        Thank you,<br>Phillip and the RESLU team
      </p>
    </div>
  </body>
</html>`;
}

export async function loadInsuranceRequestPortalData(
  supabase: SupabaseClient,
  token: string
): Promise<InsuranceRequestPortalData | null> {
  if (!/^[a-f0-9]{64}$/i.test(token)) return null;

  const { data: request } = await supabase
    .from("contact_document_requests")
    .select(
      "id,contact_id,token,requested_kinds,to_email,status,requested_at,sent_at,opened_at,completed_at,expires_at"
    )
    .eq("token", token)
    .maybeSingle();
  if (!request) return null;

  const [{ data: contact }, { data: documents }] = await Promise.all([
    supabase
      .from("contacts")
      .select("company,contact_name")
      .eq("id", request.contact_id)
      .is("deleted_at", null)
      .maybeSingle(),
    supabase
      .from("contact_documents")
      .select("kind")
      .eq("request_id", request.id)
      .is("deleted_at", null),
  ]);
  if (!contact) return null;

  const uploadedKinds = normaliseInsuranceRequestKinds(
    (documents ?? []).map((document) => document.kind)
  );

  return {
    ...request,
    requested_kinds: normaliseInsuranceRequestKinds(request.requested_kinds),
    status: request.status as InsuranceRequestStatus,
    company: contact.company,
    contact_name: contact.contact_name,
    uploaded_kinds: uploadedKinds,
  } as InsuranceRequestPortalData;
}
