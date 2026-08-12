import assert from "node:assert/strict";
import test from "node:test";
import {
  buildRealtimeProgressResponse,
  REALTIME_PROGRESS_DELAY_MS,
  REALTIME_PROGRESS_KIND,
  realtimeProgressCueId,
} from "./realtime-progress.ts";

test("acknowledgement is an out-of-band audio response that can run beside tool selection", () => {
  const event = buildRealtimeProgressResponse("cue-1", "aria", 0);
  assert.equal(event.type, "response.create");
  assert.equal(event.response.conversation, "none");
  assert.deepEqual(event.response.input, []);
  assert.deepEqual(event.response.output_modalities, ["audio"]);
  assert.equal(event.response.tool_choice, "none");
  assert.equal(event.response.metadata.reslu_kind, REALTIME_PROGRESS_KIND);
  assert.equal(realtimeProgressCueId(event.response), "cue-1");
  assert.match(event.response.instructions, /Understood\./);
  assert.equal(REALTIME_PROGRESS_DELAY_MS, 1_800);
});

test("progress lines rotate and preserve each agent's character", () => {
  const aria = buildRealtimeProgressResponse("a", "aria", 1).response.instructions;
  const marco = buildRealtimeProgressResponse("m", "marco", 1).response.instructions;
  const stuart = buildRealtimeProgressResponse("s", "stuart", 1).response.instructions;
  assert.notEqual(aria, marco);
  assert.notEqual(marco, stuart);
  assert.match(stuart, /figures/i);
  assert.doesNotMatch(`${aria} ${marco} ${stuart}`, /I’m checking that now/i);
});

test("ordinary model responses cannot be mistaken for progress audio", () => {
  assert.equal(realtimeProgressCueId(undefined), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: "answer", reslu_cue_id: "cue-1" } }), null);
  assert.equal(realtimeProgressCueId({ metadata: { reslu_kind: REALTIME_PROGRESS_KIND } }), null);
});
