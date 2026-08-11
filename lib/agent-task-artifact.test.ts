import assert from "node:assert/strict";
import test from "node:test";
import {
  agentTaskArtifactText,
  normalizeAgentTaskArtifactContent,
} from "./agent-task-artifact.ts";

test("nested model-envelope JSON renders as the email instead of raw JSON", () => {
  const email = {
    to: "phillip@reslu.com.au",
    subject: "Your new voice workspace",
    body: "Hi Phillip,\n\nThe draft is ready for review.",
  };
  const content = {
    text: JSON.stringify({
      status: "awaiting_approval",
      summary: "Voice workspace email drafted.",
      artifact: {
        artifact_key: "voice_email_v1",
        kind: "email_draft",
        content: email,
      },
    }),
  };
  assert.deepEqual(normalizeAgentTaskArtifactContent(content), email);
  assert.equal(agentTaskArtifactText(content), email.body);
});

test("ordinary brace-prefixed text and missing details remain readable", () => {
  assert.equal(agentTaskArtifactText({ text: "{Not JSON — retain this text}" }), "{Not JSON — retain this text}");
  assert.equal(agentTaskArtifactText({ unexpected: true }), "Draft details are not available yet.");
});
