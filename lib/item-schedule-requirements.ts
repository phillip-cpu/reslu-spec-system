import type {
  ItemScheduleActivity,
  ItemScheduleRequirement,
  ItemScheduleRequirementRow,
  OrderByRequirementInput,
} from "@/types/item-schedule-requirements";

export interface RequirementTaskRow {
  id: string;
  project_id: string;
  title: string;
  trade_role: string | null;
  contact_id: string | null;
  booking_date: string | null;
  phase_group_id: string | null;
  deleted_at: string | null;
}

export interface RequirementGroupRow {
  id: string;
  project_id: string;
  name: string;
  sort: number;
  phase_id: string | null;
}

export interface RequirementPhaseRow {
  id: string;
  project_id: string;
  start_date: string | null;
}

export interface RequirementTradeAssignmentRow {
  project_id: string;
  role_key: string;
  contact: { company: string } | null;
}

export interface RequirementTaskContactRow {
  id: string;
  company: string;
}

function roleKey(role: string | null): string | null {
  const clean = role?.trim().toLowerCase();
  return clean || null;
}

/**
 * Builds the one schedule-activity shape shared by the FF&E picker and the
 * order-by engine. A booked works date is precise; until it exists, the
 * linked Timeline phase start is the explicit planning fallback.
 */
export function buildItemScheduleActivities(input: {
  tasks: RequirementTaskRow[];
  groups: RequirementGroupRow[];
  phases: RequirementPhaseRow[];
  assignments?: RequirementTradeAssignmentRow[];
  taskContacts?: RequirementTaskContactRow[];
}): ItemScheduleActivity[] {
  const groupById = new Map(input.groups.map((group) => [group.id, group]));
  const phaseById = new Map(input.phases.map((phase) => [phase.id, phase]));
  const contractorByProjectRole = new Map(
    (input.assignments ?? []).map((assignment) => [
      `${assignment.project_id}:${assignment.role_key}`,
      assignment.contact?.company ?? null,
    ])
  );
  const contractorByContactId = new Map(
    (input.taskContacts ?? []).map((contact) => [contact.id, contact.company])
  );

  return input.tasks
    .filter((task) => !task.deleted_at)
    .map((task) => {
      const group = task.phase_group_id ? groupById.get(task.phase_group_id) : null;
      const phase = group?.phase_id ? phaseById.get(group.phase_id) : null;
      const key = roleKey(task.trade_role);
      return {
        id: task.id,
        project_id: task.project_id,
        title: task.title,
        trade_role: task.trade_role,
        booking_date: task.booking_date,
        phase_group_id: task.phase_group_id,
        phase_name: group?.name ?? null,
        phase_sort: group?.sort ?? null,
        phase_start_date: phase?.start_date ?? null,
        required_on_site_date: task.booking_date ?? phase?.start_date ?? null,
        contractor_company: (task.contact_id
          ? contractorByContactId.get(task.contact_id) ?? null
          : null) ?? (key
            ? contractorByProjectRole.get(`${task.project_id}:${key}`) ?? null
            : null),
      } satisfies ItemScheduleActivity;
    })
    .sort((a, b) => {
      const project = a.project_id.localeCompare(b.project_id);
      if (project !== 0) return project;
      const phase = (a.phase_sort ?? Number.MAX_SAFE_INTEGER) - (b.phase_sort ?? Number.MAX_SAFE_INTEGER);
      if (phase !== 0) return phase;
      return a.title.localeCompare(b.title);
    });
}

export function attachActivitiesToRequirements(
  rows: ItemScheduleRequirementRow[],
  activities: ItemScheduleActivity[]
): ItemScheduleRequirement[] {
  const activityById = new Map(activities.map((activity) => [activity.id, activity]));
  return rows.map((row) => ({
    ...row,
    activity: activityById.get(row.board_task_id) ?? null,
  }));
}

export function toOrderByRequirementInputs(
  requirements: ItemScheduleRequirement[]
): OrderByRequirementInput[] {
  return requirements.map((requirement) => ({
    id: requirement.id,
    project_id: requirement.project_id,
    item_id: requirement.item_id,
    board_task_id: requirement.board_task_id,
    buffer_days: requirement.buffer_days,
    activity_title: requirement.activity?.title ?? null,
    trade_role: requirement.activity?.trade_role ?? null,
    required_on_site_date: requirement.activity?.required_on_site_date ?? null,
  }));
}
