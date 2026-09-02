import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  attachActivitiesToRequirements,
  buildItemScheduleActivities,
  toOrderByRequirementInputs,
  type RequirementGroupRow,
  type RequirementPhaseRow,
  type RequirementTaskRow,
  type RequirementTaskContactRow,
  type RequirementTradeAssignmentRow,
} from "./item-schedule-requirements.ts";
import type {
  ItemScheduleActivity,
  ItemScheduleRequirement,
  ItemScheduleRequirementRow,
  OrderByRequirementInput,
} from "@/types/item-schedule-requirements";

const REQUIREMENT_SELECT =
  "id,project_id,item_id,board_task_id,buffer_days,notes,created_at,updated_at";

export async function loadItemScheduleRequirementData(
  supabase: SupabaseClient,
  projectIds: string[],
  options: { includeAllActivities?: boolean; includeContractors?: boolean } = {}
): Promise<{
  requirements: ItemScheduleRequirement[];
  activities: ItemScheduleActivity[];
  orderByInputs: OrderByRequirementInput[];
}> {
  const ids = [...new Set(projectIds.filter(Boolean))];
  if (ids.length === 0) return { requirements: [], activities: [], orderByInputs: [] };

  const { data: requirementRows, error: requirementError } = await supabase
    .from("item_schedule_requirements")
    .select(REQUIREMENT_SELECT)
    .in("project_id", ids)
    .order("created_at", { ascending: true });
  if (requirementError) throw new Error(requirementError.message);

  const rows = (requirementRows ?? []) as ItemScheduleRequirementRow[];
  const referencedTaskIds = [...new Set(rows.map((row) => row.board_task_id))];
  if (!options.includeAllActivities && referencedTaskIds.length === 0) {
    return { requirements: [], activities: [], orderByInputs: [] };
  }

  let taskQuery = supabase
    .from("board_tasks")
    .select("id,project_id,title,trade_role,contact_id,booking_date,phase_group_id,deleted_at");
  taskQuery = options.includeAllActivities
    ? taskQuery.in("project_id", ids)
    : taskQuery.in("id", referencedTaskIds);
  const { data: taskRows, error: taskError } = await taskQuery;
  if (taskError) throw new Error(taskError.message);

  const tasks = (taskRows ?? []) as RequirementTaskRow[];
  const groupIds = [...new Set(tasks.map((task) => task.phase_group_id).filter(Boolean))] as string[];
  const { data: groupRows, error: groupError } = groupIds.length
    ? await supabase
        .from("board_groups")
        .select("id,project_id,name,sort,phase_id")
        .in("id", groupIds)
    : { data: [] as RequirementGroupRow[], error: null };
  if (groupError) throw new Error(groupError.message);

  const groups = (groupRows ?? []) as RequirementGroupRow[];
  const phaseIds = [...new Set(groups.map((group) => group.phase_id).filter(Boolean))] as string[];
  const { data: phaseRows, error: phaseError } = phaseIds.length
    ? await supabase
        .from("schedule_phases")
        .select("id,project_id,start_date")
        .in("id", phaseIds)
    : { data: [] as RequirementPhaseRow[], error: null };
  if (phaseError) throw new Error(phaseError.message);

  const taskContactIds = [...new Set(tasks.map((task) => task.contact_id).filter(Boolean))] as string[];
  const [assignmentResult, taskContactResult] = options.includeContractors
    ? await Promise.all([
        supabase
          .from("project_trade_assignments")
          .select("project_id,role_key,contact:contacts!project_trade_assignments_contact_id_fkey(company)")
          .in("project_id", ids),
        taskContactIds.length
          ? supabase.from("contacts").select("id,company").in("id", taskContactIds)
          : Promise.resolve({ data: [] as RequirementTaskContactRow[], error: null }),
      ])
    : [
        { data: [] as RequirementTradeAssignmentRow[], error: null },
        { data: [] as RequirementTaskContactRow[], error: null },
      ];
  const { data: assignmentRows, error: assignmentError } = assignmentResult;
  if (assignmentError) throw new Error(assignmentError.message);
  if (taskContactResult.error) throw new Error(taskContactResult.error.message);

  const activities = buildItemScheduleActivities({
    tasks,
    groups,
    phases: (phaseRows ?? []) as RequirementPhaseRow[],
    assignments: (assignmentRows ?? []) as unknown as RequirementTradeAssignmentRow[],
    taskContacts: (taskContactResult.data ?? []) as RequirementTaskContactRow[],
  });
  const requirements = attachActivitiesToRequirements(rows, activities);
  return {
    requirements,
    activities,
    orderByInputs: toOrderByRequirementInputs(requirements),
  };
}
