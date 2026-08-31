import type { AgentTask, ConversationKind } from "@/types/conversations";

export interface WorkroomConversation {
  id: string;
  kind: ConversationKind;
  title: string;
}

export interface WorkroomTask extends AgentTask {
  conversation: WorkroomConversation;
}

export interface WorkroomRoutine {
  id: string;
  label: string;
  owner: string;
  schedule: string;
  cadence: string;
}

export interface WorkroomApprovalPolicy {
  tool_name: string;
  owner: string;
  purpose: string;
  risk_tier: "R2" | "R3";
  approval_rule: "exact-owner" | "exact-owner-plus-review";
  verification_kind: "draft_record" | "spec_readback" | "provider_readback" | "specialised";
  rollback_kind: "delete-draft" | "restore-version" | "compensating-action" | "manual-recovery" | "specialised";
}

export interface WorkroomResponse {
  tasks: WorkroomTask[];
  routines: WorkroomRoutine[];
  approval_policies: WorkroomApprovalPolicy[];
  self_profile_id: string;
  generated_at: string;
}
