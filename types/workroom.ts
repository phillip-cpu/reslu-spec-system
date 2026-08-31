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
  description: string;
  schedule: string;
  cadence: string;
  next_run_at: string | null;
  monitoring_key: string | null;
  monitoring_status: "healthy" | "warning" | "failed" | "late" | "never" | "unmonitored";
  last_run_at: string | null;
  last_success_at: string | null;
  last_error: string | null;
  recent_runs: WorkroomRoutineRun[];
}

export interface WorkroomRoutineRun {
  id: string;
  status: "succeeded" | "degraded" | "failed";
  started_at: string;
  finished_at: string;
  duration_ms: number;
  summary: Record<string, unknown>;
  error: string | null;
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
