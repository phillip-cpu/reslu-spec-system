import assert from "node:assert/strict";
import test from "node:test";
import { structureMeetingTranscript } from "./meeting-minutes-structure.ts";

test("structures minutes with strict OpenAI JSON schema", async () => {
  let requestBody: {
    model?: unknown;
    text?: { format?: { type?: unknown; strict?: unknown; schema?: { additionalProperties?: unknown } } };
  } | undefined;
  const result = await structureMeetingTranscript("Phillip asked RESLU to send the revised plan.", {
    apiKey: "test-key",
    model: "gpt-test",
    fetchImpl: async (_url, init) => {
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [{
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              summary: "A revised plan was requested.",
              decisions: [],
              client_requests: ["Send the revised plan."],
              reslu_actions: ["Send the revised plan."],
              client_actions: [],
              open_questions: [],
              important_notes: [],
            }),
          }],
        }],
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });

  assert.equal(requestBody?.model, "gpt-test");
  assert.equal(requestBody?.text?.format?.type, "json_schema");
  assert.equal(requestBody?.text?.format?.strict, true);
  assert.equal(requestBody?.text?.format?.schema?.additionalProperties, false);
  assert.deepEqual(result.reslu_actions, ["Send the revised plan."]);
});

test("does not expose the server key in provider errors", async () => {
  await assert.rejects(() => structureMeetingTranscript("Transcript", {
    apiKey: "secret-test-key",
    fetchImpl: async () => new Response(JSON.stringify({ error: { message: "Invalid request" } }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    }),
  }), (error: unknown) => error instanceof Error
      && error.message.includes("Invalid request")
      && !error.message.includes("secret-test-key"));
});
