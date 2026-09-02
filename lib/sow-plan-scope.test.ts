import assert from "node:assert/strict";
import test from "node:test";
import {
  planFilenamesForSowRoom,
  sowPlanFileScope,
  sowRoomAwaitsWorkingDrawings,
  sowRoomPlanScope,
} from "./sow-plan-scope.ts";

const HONE_PLANS = [
  "260901_Hone_WD_STAGE 2_INTERNAL WORKS.pdf",
  "260831_Hone_WD_STAGE 2_JOINERY FOR CLIENT REVIEW_P1.pdf",
];

test("keeps clearly labelled interior plans away from exterior rooms", () => {
  assert.equal(sowRoomPlanScope("External Envelope"), "exterior");
  assert.equal(sowRoomPlanScope("Alfresco"), "exterior");
  assert.equal(sowRoomPlanScope("Backyard"), "exterior");
  assert.equal(sowRoomPlanScope("Laundry"), "interior");
  assert.deepEqual(planFilenamesForSowRoom("Laundry", HONE_PLANS), HONE_PLANS);
  assert.deepEqual(planFilenamesForSowRoom("Backyard", HONE_PLANS), []);
  assert.equal(sowRoomAwaitsWorkingDrawings("Backyard", HONE_PLANS), true);
});

test("uses the exterior set once it is uploaded and preserves shared sets", () => {
  const plans = [...HONE_PLANS, "Hone Exterior Working Drawings.pdf", "Hone General Details.pdf"];
  assert.equal(sowPlanFileScope("Hone Exterior Working Drawings.pdf"), "exterior");
  assert.deepEqual(planFilenamesForSowRoom("Alfresco", plans), [
    "Hone Exterior Working Drawings.pdf",
    "Hone General Details.pdf",
  ]);
  assert.equal(sowRoomAwaitsWorkingDrawings("Alfresco", plans), false);
});
