import assert from "node:assert/strict";
import test from "node:test";
import { normalizeProjectDetailsUpdate, verifyProjectDetails } from "./project-details.mjs";

test("project detail update accepts a version-bound address correction", () => {
  const result = normalizeProjectDetailsUpdate({
    project_id: "project-1",
    expected_updated_at: "2026-08-18T06:01:29.000Z",
    address: "4 Belinda Street, Evandale SA",
  });
  assert.deepEqual(result, {
    projectId: "project-1",
    expectedUpdatedAt: "2026-08-18T06:01:29.000Z",
    patch: { address: "4 Belinda Street, Evandale SA" },
  });
});

test("project detail update rejects business outcomes and empty mutations", () => {
  const base = {
    project_id: "project-1",
    expected_updated_at: "2026-08-18T06:01:29.000Z",
  };
  assert.throws(() => normalizeProjectDetailsUpdate(base), /At least one/);
  assert.throws(() => normalizeProjectDetailsUpdate({ ...base, status: "archived" }), /not editable/);
  assert.throws(() => normalizeProjectDetailsUpdate({ ...base, budget: 1000 }), /not editable/);
});

test("project detail update requires the current version", () => {
  assert.throws(() => normalizeProjectDetailsUpdate({
    project_id: "project-1",
    address: "4 Belinda Street",
  }), /expected_updated_at/);
});

test("project detail readback fails closed on a mismatched result", () => {
  assert.equal(verifyProjectDetails({ address: "4 Belinda Street" }, { address: "4 Belinda Street" }), true);
  assert.throws(
    () => verifyProjectDetails({ address: "Evandale" }, { address: "4 Belinda Street" }),
    /address/,
  );
});
