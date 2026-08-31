import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = readFileSync(resolve(root, "components/workroom/WorkroomWorkspace.tsx"), "utf8");
const page = readFileSync(resolve(root, "app/(dashboard)/workroom/page.tsx"), "utf8");

test("Workroom navigation survives refresh and browser history", () => {
  assert.match(page, /initialView=\{params\.view/);
  assert.match(page, /initialTaskId=\{params\.task/);
  assert.match(workspace, /window\.history\[mode === "push" \? "pushState" : "replaceState"\]/);
  assert.match(workspace, /addEventListener\("popstate"/);
});

test("mobile Workroom uses compact navigation and reachable actions", () => {
  assert.match(workspace, /Workroom view/);
  assert.match(workspace, /Jump to \{draftArtifacts\.length > 0 \? "decision" : "actions"\}/);
  assert.match(workspace, /workroom-task-actions sticky bottom-0/);
});

test("Recovery can be searched, filtered and inspected with safe guidance", () => {
  assert.match(workspace, /Search this Workroom view/);
  assert.match(workspace, /Approved work to verify/);
  assert.match(workspace, /What happened/);
  assert.match(workspace, /Next safe step/);
});

test("each routine opens to explain its purpose and technical schedule", () => {
  assert.match(workspace, /<details key=\{routine\.id\}/);
  assert.match(workspace, /What it does/);
  assert.match(workspace, /Adelaide time/);
  assert.match(workspace, /Endpoint/);
});
