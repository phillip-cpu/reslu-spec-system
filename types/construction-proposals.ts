import type { ProposalContent } from "./proposals";

export type ConstructionGroup = "internal" | "external" | "preliminaries" | "option";
export interface ConstructionPayment { label: string; percentage: number }
export interface ConstructionSelection {
  estimate_version_id: string;
  sow_id: string;
  groups: Record<string, ConstructionGroup>;
  scope_groups: Record<string, ConstructionGroup>;
  payments: ConstructionPayment[];
  previous_proposal_id?: string;
}
export interface ConstructionPrice {
  key: string;
  label: string;
  selling_ex_gst: number;
}
export interface ConstructionMetadata {
  schema: 1;
  variation?: {
    package_id: string;
    accepted_proposal_id: string;
    accepted_version_digest: string;
    description: string;
    time_effect_days: number;
    time_effect_note: string;
    approval_history: { proposal_id: string; version_digest: string; decision: "accepted"; name: string; at: string }[];
  };
  estimate_version_id: string;
  estimate_label: string;
  sow_id: string;
  sow_revision: string;
  source_digest: string;
  previous_proposal_id: string | null;
  prices: (ConstructionPrice & { group: ConstructionGroup | "variation" })[];
  payments: (ConstructionPayment & { amount_inc: number })[];
  subtotal_ex_gst: number;
  gst: number;
  total_inc: number;
  estimate_total_inc: number;
  changes: string[];
}
export type ConstructionContent = ProposalContent & { kind: "construction"; construction: ConstructionMetadata };
