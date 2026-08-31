import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { cronCadence, workroomCounts, workroomRoutines, workroomView } from "./workroom.ts";
import type { AgentTask } from "../types/conversations.ts";

function task(status: AgentTask["status"]): AgentTask {
  return { status } as AgentTask;
}

test("Workroom separates attention, outstanding and finished assignments", () => {
  assert.equal(workroomView(task("awaiting_approval")), "attention");
  assert.equal(workroomView(task("failed")), "attention");
  assert.equal(workroomView(task("running")), "outstanding");
  assert.equal(workroomView(task("completed")), "history");
  assert.deepEqual(workroomCounts([task("queued"), task("failed"), task("completed")]), {
    attention: 1,
    outstanding: 1,
    history: 1,
  });
});

test("deployment schedules become transparent Workroom routines", () => {
  assert.equal(cronCadence("*/15 * * * *"), "Every 15 minutes");
  assert.equal(cronCadence("30 21 * * 0"), "Weekly");
  const routines = workroomRoutines([{ path: "/api/aria-queue/routines/daily_review", schedule: "15 21 * * *" }]);
  assert.deepEqual(routines[0], {
    id: "/api/aria-queue/routines/daily_review",
    label: "Daily work review",
    owner: "Aria",
    schedule: "15 21 * * *",
    cadence: "Daily",
  });
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
