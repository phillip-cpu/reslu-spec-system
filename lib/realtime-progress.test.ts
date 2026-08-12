import assert from "node:assert/strict";
import test from "node:test";
import {
  REALTIME_PROGRESS_KIND,
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
