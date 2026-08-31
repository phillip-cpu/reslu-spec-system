import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROJECT_TYPE,
  FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES,
  FALLBACK_PROJECT_PHASE_TEMPLATES,
  PROJECT_TYPES,
  inferProjectTypeFromText,
  inferSingleRoomSubtypeFromText,
  normaliseProjectSubtype,
  resolveProjectPhaseTemplates,
  templateForProjectType,
} from "./project-templates.ts";

test("every project type has Timeline and balanced client payment defaults", () => {
  for (const projectType of PROJECT_TYPES) {
    assert.ok(FALLBACK_PROJECT_PHASE_TEMPLATES[projectType].length > 0);
    assert.equal(
      FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[projectType].reduce(
        (sum, stage) => sum + stage.percentage,
        0
      ),
      100
    );
    assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[projectType][0].percentage, 5);
    assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[projectType][0].phaseName, null);
    const phaseNames = new Set(FALLBACK_PROJECT_PHASE_TEMPLATES[projectType].map((row) => row.name));
    for (const stage of FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[projectType].slice(1)) {
      assert.ok(stage.phaseName && phaseNames.has(stage.phaseName));
    }
    assert.ok(
      FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES[projectType].some((stage) =>
        stage.label.toLocaleLowerCase().includes("joinery")
      )
    );
  }
});

test("approved construction payment templates keep the agreed number of claims", () => {
  assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.new_build.length, 10);
  assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.whole_home_renovation.length, 7);
  assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.extension.length, 10);
  assert.equal(FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.single_room_renovation.length, 5);

  assert.deepEqual(
    FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.whole_home_renovation.map((stage) => stage.percentage),
    [5, 15, 20, 15, 20, 20, 5]
  );
  assert.deepEqual(
    FALLBACK_PROJECT_PAYMENT_STAGE_TEMPLATES.single_room_renovation.map((stage) => stage.percentage),
    [5, 25, 25, 35, 10]
  );
});

test("legacy single phase template is preserved for whole-home renovations", () => {
  const legacy = [{ name: "Legacy renovation stage", kind: "phase" as const }];
  const resolved = resolveProjectPhaseTemplates(legacy);
  assert.deepEqual(resolved.whole_home_renovation, legacy);
  assert.deepEqual(resolved.new_build, FALLBACK_PROJECT_PHASE_TEMPLATES.new_build);
});

test("missing project type uses the non-destructive rollout default", () => {
  assert.equal(DEFAULT_PROJECT_TYPE, "whole_home_renovation");
  assert.deepEqual(
    templateForProjectType(FALLBACK_PROJECT_PHASE_TEMPLATES, null),
    FALLBACK_PROJECT_PHASE_TEMPLATES.whole_home_renovation
  );
});

test("single-room subtype is only retained for single-room projects", () => {
  assert.equal(normaliseProjectSubtype("single_room_renovation", "kitchen"), "kitchen");
  assert.equal(normaliseProjectSubtype("new_build", "kitchen"), null);
});

test("lead text maps into the supported project types and room subtypes", () => {
  assert.equal(inferProjectTypeFromText("New Build"), "new_build");
  assert.equal(inferProjectTypeFromText("Rear addition"), "extension");
  assert.equal(inferProjectTypeFromText("Main bathroom renovation"), "single_room_renovation");
  assert.equal(inferProjectTypeFromText("Renovation"), "whole_home_renovation");
  assert.equal(inferSingleRoomSubtypeFromText("Powder room / other"), "other");
  assert.equal(inferSingleRoomSubtypeFromText("Ensuite renovation"), "ensuite");
});
