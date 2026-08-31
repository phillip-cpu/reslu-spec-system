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

export interface WorkroomResponse {
  tasks: WorkroomTask[];
  routines: WorkroomRoutine[];
  self_profile_id: string;
  generated_at: string;
}
