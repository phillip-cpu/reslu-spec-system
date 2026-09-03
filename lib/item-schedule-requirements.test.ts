import assert from "node:assert/strict";
import test from "node:test";
import {
  attachActivitiesToRequirements,
  buildItemScheduleActivities,
  toOrderByRequirementInputs,
} from "./item-schedule-requirements.ts";

const tasks = [
  {
    id: "task-booked",
    project_id: "project-1",
    title: "Plumbing rough-in",
    trade_role: "Plumber",
    contact_id: null,
    booking_date: "2026-11-12",
    phase_group_id: "group-1",
    deleted_at: null,
  },
  {
    id: "task-phase",
    project_id: "project-1",
    title: "Install tapware",
    trade_role: "Plumber",
    contact_id: "manual-plumber",
    booking_date: null,
    phase_group_id: "group-2",
    deleted_at: null,
  },
  {
    id: "task-deleted",
    project_id: "project-1",
    title: "Old activity",
    trade_role: "Plumber",
    contact_id: null,
    booking_date: "2026-10-01",
    phase_group_id: null,
    deleted_at: "2026-09-01T00:00:00Z",
  },
];

test("uses a task works date before its Timeline phase start", () => {
  const activities = buildItemScheduleActivities({
    tasks,
    groups: [
      { id: "group-1", project_id: "project-1", name: "Rough-in", sort: 2, phase_id: "phase-1" },
      { id: "group-2", project_id: "project-1", name: "Fit-off", sort: 5, phase_id: "phase-2" },
    ],
    phases: [
      { id: "phase-1", project_id: "project-1", start_date: "2026-11-10" },
      { id: "phase-2", project_id: "project-1", start_date: "2027-01-15" },
    ],
    assignments: [
      { project_id: "project-1", role_key: "plumber", contact: { company: "Monster Plumbing" } },
    ],
    taskContacts: [
      { id: "manual-plumber", company: "Exact Plumbing" },
    ],
  });

  assert.deepEqual(activities.map((activity) => activity.id), ["task-booked", "task-phase"]);
  assert.equal(activities[0].required_on_site_date, "2026-11-12");
  assert.equal(activities[1].required_on_site_date, "2027-01-15");
  assert.equal(activities[0].contractor_company, "Monster Plumbing");
  assert.equal(activities[1].contractor_company, "Exact Plumbing");
});

test("keeps a missing/deleted activity visible on an existing requirement", () => {
  const rows = [{
    id: "req-1",
    project_id: "project-1",
    item_id: "item-1",
    board_task_id: "task-deleted",
    buffer_days: 0,
    notes: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
  }];
  const attached = attachActivitiesToRequirements(rows, []);
  assert.equal(attached[0].activity, null);
  assert.equal(toOrderByRequirementInputs(attached)[0].required_on_site_date, null);
});
