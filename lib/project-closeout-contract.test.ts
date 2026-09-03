import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const stageRoute = readFileSync(
  resolve(root, "app/api/projects/[id]/stage/route.ts"),
  "utf8"
);
const closeoutRoute = readFileSync(
  resolve(root, "app/api/projects/[id]/closeout/route.ts"),
  "utf8"
);
const projectRoute = readFileSync(
  resolve(root, "app/api/projects/[id]/route.ts"),
  "utf8"
);
const commercialRoute = readFileSync(
  resolve(root, "app/api/projects/[id]/commercial/route.ts"),
  "utf8"
);

test("finalisation requires Handover and an explicit acknowledgement when attention remains", () => {
  assert.match(stageRoute, /current\.project_stage !== "handover"/);
  assert.match(stageRoute, /closeout_handover_required/);
  assert.match(stageRoute, /!readiness\.ready && body\.closeout_acknowledged !== true/);
  assert.match(stageRoute, /closeout_review_required/);
});

test("the closeout endpoint is authenticated and derives rather than stores readiness", () => {
  assert.match(closeoutRoute, /getUserRole\(supabase\)/);
  assert.match(closeoutRoute, /user\.role !== "admin"/);
  assert.match(closeoutRoute, /loadProjectCloseoutReadiness\(supabase, projectId\)/);
  assert.doesNotMatch(closeoutRoute, /\.insert\(|\.update\(|\.upsert\(/);
});

test("generic settings and commercial setup cannot bypass the lifecycle route", () => {
  assert.match(projectRoute, /delete body\.project_stage/);
  assert.match(projectRoute, /delete body\.status/);
  assert.doesNotMatch(commercialRoute, /\.update\(\{ project_stage:/);
});
