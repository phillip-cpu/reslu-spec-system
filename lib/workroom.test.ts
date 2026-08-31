import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cronCadence, filterWorkroomTasks, nextCronRun, recoveryGuidance, recoveryKind, workroomCounts, workroomRoutines, workroomView } from "./workroom.ts";
import type { AgentTask } from "../types/conversations.ts";
import type { WorkroomTask } from "../types/workroom.ts";

function task(status: AgentTask["status"]): AgentTask {
  return { status } as AgentTask;
}

test("Workroom separates approvals, recovery, outstanding and finished assignments", () => {
  assert.equal(workroomView(task("awaiting_approval")), "approvals");
  assert.equal(workroomView(task("failed")), "recovery");
  assert.equal(workroomView(task("running")), "outstanding");
  assert.equal(workroomView(task("completed")), "history");
  assert.deepEqual(workroomCounts([task("queued"), task("failed"), task("completed")]), {
    approvals: 0,
    recovery: 1,
    outstanding: 1,
    history: 1,
  });
});

test("deployment schedules become transparent Workroom routines", () => {
  assert.equal(cronCadence("*/15 * * * *"), "Every 15 minutes");
  assert.equal(cronCadence("30 21 * * 0"), "Weekly");
  const routines = workroomRoutines([{ path: "/api/aria-queue/routines/daily_review", schedule: "15 21 * * *" }], new Date("2026-08-31T20:00:00.000Z"));
  assert.deepEqual(routines[0], {
    id: "/api/aria-queue/routines/daily_review",
    label: "Daily work review",
    owner: "Aria",
    description: "Reviews Aria's outstanding work and creates a concise daily follow-up assignment.",
    schedule: "15 21 * * *",
    cadence: "Daily",
    next_run_at: "2026-08-31T21:15:00.000Z",
  });
  assert.equal(nextCronRun("*/15 * * * *", new Date("2026-08-31T20:07:00.000Z")), "2026-08-31T20:15:00.000Z");
  assert.equal(nextCronRun("30 22,23,1,2,5,6 * * *", new Date("2026-08-31T22:31:00.000Z")), "2026-08-31T23:30:00.000Z");
});

function workroomTask(overrides: Partial<WorkroomTask>): WorkroomTask {
  return {
    id: "task",
    conversation_id: "conversation",
    requested_by: "person",
    owner_agent_id: "agent",
    source_message_id: null,
    source_call_id: null,
    client_task_id: "client-task",
    title: "Test task",
    objective: "Test objective",
    requested_via: "text",
    status: "failed",
    model_tier: "standard",
    model_name: null,
    approval_state: "none",
    approval_note: null,
    result_summary: null,
    error: "Specific provider error",
    retry_count: 0,
    gateway_run_id: null,
    progress_label: null,
    progress_updated_at: null,
    cancellation_requested_at: null,
    claimed_at: null,
    completed_at: null,
    created_at: "2026-08-20T00:00:00.000Z",
    updated_at: "2026-08-20T00:00:00.000Z",
    conversation: { id: "conversation", kind: "direct", title: "Marco" },
    events: [],
    artifacts: [],
    ...overrides,
  };
}

test("Recovery is grouped by risk and then sorted by latest real activity", () => {
  const approved = workroomTask({ id: "approved", approval_state: "approved", updated_at: "2026-08-19T00:00:00.000Z" });
  const generic = workroomTask({ id: "generic", error: "OpenClaw run failed", updated_at: "2026-08-31T00:00:00.000Z" });
  const recentManual = workroomTask({ id: "manual-new", title: "Email connector", updated_at: "2026-08-30T00:00:00.000Z" });
  const oldManual = workroomTask({ id: "manual-old", updated_at: "2026-08-21T00:00:00.000Z" });
  const result = filterWorkroomTasks([oldManual, generic, recentManual, approved], "recovery");
  assert.deepEqual(result.map((item) => item.id), ["approved", "generic", "manual-new", "manual-old"]);
  assert.equal(recoveryKind(generic), "needs-diagnosis");
  assert.match(recoveryGuidance(generic).nextStep, /external state/i);
});

test("Recovery and history filters search all useful task context", () => {
  const marco = workroomTask({ id: "marco", title: "Search Console verification", requested_by: "self" });
  const aria = workroomTask({ id: "aria", title: "Invoice email", owner_agent_id: "aria" });
  assert.deepEqual(filterWorkroomTasks([aria, marco], "recovery", "all", "console").map((item) => item.id), ["marco"]);
  assert.deepEqual(filterWorkroomTasks([aria, marco], "recovery", "all", "", "retryable", "self").map((item) => item.id), ["marco"]);
});

test("Workroom has a page, API, and first-class sidebar entry", () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const nav = readFileSync(resolve(root, "lib/navigation.ts"), "utf8");
  const page = readFileSync(resolve(root, "app/(dashboard)/workroom/page.tsx"), "utf8");
  const route = readFileSync(resolve(root, "app/api/workroom/route.ts"), "utf8");
  assert.match(nav, /id: "workroom", label: "Workroom", href: "\/workroom"/);
  assert.match(page, /title="Workroom"/);
  assert.match(route, /from\("agent_tasks"\)/);
  assert.match(route, /workroomRoutines\(vercel\.crons\)/);
});
