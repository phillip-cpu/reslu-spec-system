import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealtimeProgressResponse,
  REALTIME_PROGRESS_KIND,
  realtimeProgressCueId,
} from "./realtime-progress.ts";

test("acknowledgement is an out-of-band audio response that can run beside tool selection", () => {
  const event = buildRealtimeProgressResponse("cue-1");
  assert.equal(event.type, "response.create");
  assert.equal(event.response.conversation, "none");
  assert.deepEqual(event.response.input, []);
  assert.deepEqual(event.response.output_modalities, ["audio"]);
  assert.equal(event.response.tool_choice, "none");
  assert.equal(event.response.metadata.reslu_kind, REALTIME_PROGRESS_KIND);
  assert.equal(realtimeProgressCueId(event.response), "cue-1");
});

test("ordinary model responses cannot be mistaken for progress audio", () => {
  assert.equal(realtimeProgressCueId(undefined), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: "answer", reslu_cue_id: "cue-1" } }), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: REALTIME_PROGRESS_KIND } }), null);
});
