import assert from "node:assert/strict";
import test from "node:test";
import {
  REALTIME_PROGRESS_KIND,
  realtimeProgressAcknowledgement,
  realtimeProgressCueId,
} from "./realtime-progress.ts";

test("legacy progress responses remain identifiable so stale audio can be cancelled", () => {
  const response = { metadata: { reslu_kind: REALTIME_PROGRESS_KIND, reslu_cue_id: "cue-1" } };
  assert.equal(realtimeProgressCueId(response), "cue-1");
});

test("ordinary model responses cannot be mistaken for progress audio", () => {
  assert.equal(realtimeProgressCueId(undefined), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: "answer", reslu_cue_id: "cue-1" } }), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: REALTIME_PROGRESS_KIND } }), null);
});

test("progress acknowledgements rotate by agent without the retired checking phrase", () => {
  assert.equal(realtimeProgressAcknowledgement("aria", 1), "I’ll take care of that.");
  assert.equal(realtimeProgressAcknowledgement("aria", 2), "I’ll pull that together.");
  assert.equal(realtimeProgressAcknowledgement("marco", 1), "On it.");
  assert.equal(realtimeProgressAcknowledgement("stuart", 1), "Right.");
  assert.equal(realtimeProgressAcknowledgement("aria", 4), "I’ll take care of that.");
  for (const slug of ["aria", "marco", "stuart", "unknown"]) {
    for (let turn = 1; turn <= 6; turn += 1) {
      assert.doesNotMatch(realtimeProgressAcknowledgement(slug, turn), /checking/i);
    }
  }
});
