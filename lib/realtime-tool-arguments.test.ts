import assert from "node:assert/strict";
import test from "node:test";
import {
  parseRealtimeConsultArguments,
  parseRealtimeSpecialistArguments,
  parseRealtimeTaskArguments,
} from "./realtime-tool-arguments.ts";

test("consult arguments wait for a complete bounded query", () => {
  assert.equal(parseRealtimeConsultArguments("{}"), null);
  assert.equal(parseRealtimeConsultArguments('{"query":'), null);
  assert.deepEqual(parseRealtimeConsultArguments('{"query":"  What is first today?  "}'), {
    query: "What is first today?",
  });
});

test("specialist arguments require a different known RESLU agent", () => {
  assert.deepEqual(parseRealtimeSpecialistArguments(JSON.stringify({
    query: " Ask Stuart for the finance risk. ",
    target_agent_slug: "stuart",
  }), "aria"), {
    query: "Ask Stuart for the finance risk.",
    targetAgent: "stuart",
  });
  assert.equal(parseRealtimeSpecialistArguments(JSON.stringify({
    query: "Ask Aria",
    target_agent_slug: "aria",
  }), "aria"), null);
  assert.equal(parseRealtimeSpecialistArguments(JSON.stringify({
    query: "Ask an external adviser",
    target_agent_slug: "external",
  }), "aria"), null);
});

test("task arguments wait for a complete title and objective", () => {
  assert.equal(parseRealtimeTaskArguments('{"title":"Draft email"}'), null);
  assert.deepEqual(parseRealtimeTaskArguments(JSON.stringify({
    title: " Draft email ",
    objective: " Prepare it but do not send. ",
    model_tier: "strong",
  })), {
    title: "Draft email",
    objective: "Prepare it but do not send.",
    modelTier: "strong",
  });
});

test("unknown task tiers safely use the standard model", () => {
  assert.equal(parseRealtimeTaskArguments(JSON.stringify({
    title: "Test",
    objective: "Run the voice test",
    model_tier: "unknown",
  }))?.modelTier, "standard");
});
