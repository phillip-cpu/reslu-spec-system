import type { ContactDocumentKind } from "@/lib/insurance";

export type InsuranceRequestKind = Exclude<ContactDocumentKind, "other">;
export type InsuranceRequestStatus = "requested" | "opened" | "completed" | "cancelled";

export interface InsuranceRequestSummary {
  id: string;
  requested_kinds: InsuranceRequestKind[];
  to_email: string;
  status: InsuranceRequestStatus;
  requested_at: string;
  sent_at: string | null;
  opened_at: string | null;
  completed_at: string | null;
  expires_at: string;
}

export interface InsuranceRequestPortalData extends InsuranceRequestSummary {
  token: string;
  contact_id: string;
  company: string;
  contact_name: string | null;
  uploaded_kinds: InsuranceRequestKind[];
}

export interface SendInsuranceRequestInput {
  kinds?: InsuranceRequestKind[];
}
