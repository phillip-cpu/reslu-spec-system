export type SupplierQuotePackageStatus = "draft" | "sent" | "complete" | "closed";
export type SupplierQuoteRequestStatus =
  | "draft"
  | "sent"
  | "acknowledged"
  | "quote_received"
  | "declined"
  | "selected"
  | "closed";

export interface SupplierQuoteLine {
  id: string;
  package_id: string;
  cost_line_id: string;
  description_snapshot: string;
  qty_snapshot: number | null;
  unit_snapshot: string | null;
  sort: number;
}

export interface SupplierQuoteAttachment {
  id: string;
  package_id: string;
  request_id: string | null;
  kind: "request" | "response";
  filename: string;
  mime: string | null;
  caption: string | null;
  byte_size: number | null;
  created_at: string;
  url: string | null;
}

export interface SupplierQuoteEmail {
  id: string;
  direction: "inbound" | "sent";
  from_addr: string;
  subject: string | null;
  received_at: string;
  clean_text: string | null;
  attachments: { id: string; filename: string | null; mime: string | null }[];
}

export interface SupplierQuoteRequest {
  id: string;
  package_id: string;
  contact_id: string | null;
  token: string;
  status: SupplierQuoteRequestStatus;
  sent_to_email: string | null;
  sent_at: string | null;
  acknowledgement_due_at: string | null;
  acknowledged_at: string | null;
  promised_quote_at: string | null;
  quote_received_at: string | null;
  quote_amount_ex_gst: number | null;
  quote_reference: string | null;
  response_note: string | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  last_reply_at: string | null;
  last_followup_at: string | null;
  contact: { id: string; company: string; contact_name: string | null; email: string | null } | null;
  emails: SupplierQuoteEmail[];
  response_lines: { package_line_id: string; amount_ex_gst: number | null; note: string | null }[];
}

export interface SupplierQuotePackage {
  id: string;
  project_id: string;
  title: string;
  scope: string | null;
  requested_quote_date: string | null;
  status: SupplierQuotePackageStatus;
  sent_at: string | null;
  created_at: string;
  lines: SupplierQuoteLine[];
  requests: SupplierQuoteRequest[];
  attachments: SupplierQuoteAttachment[];
}

export interface SupplierQuoteLineSummary {
  package_id: string;
  package_title: string;
  request_count: number;
  received_count: number;
  next_due: string | null;
  supplier_names: string[];
}
