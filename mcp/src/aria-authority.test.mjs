import assert from "node:assert/strict";
import test from "node:test";
import {
  decorateAriaTool,
  policyMapFromResponse,
  splitAriaAuthorityArgs,
} from "./aria-authority.mjs";

const tool = {
  name: "update_lead",
  description: "Update a lead",
  inputSchema: { type: "object", properties: { lead_id: { type: "string" } }, required: ["lead_id"], additionalProperties: false },
};

test("R1 tools keep their normal inputs and add a mandatory audit envelope", () => {
  const decorated = decorateAriaTool(tool, { risk_tier: "R1", action_class: "prepare" });
  assert.deepEqual(decorated.inputSchema.required, ["lead_id", "_authority"]);
  assert.equal(decorated.inputSchema.properties._authority.required.includes("approval_receipt_id"), false);
  assert.match(decorated.description, /No approval is needed/);
});

test("R2 tools explain exact approval without changing the shared envelope shape", () => {
  const decorated = decorateAriaTool(tool, { risk_tier: "R2", action_class: "commit" });
  assert.match(decorated.description, /approval_receipt_id is mandatory/);
});

test("the authority envelope is removed before business-handler invocation", () => {
  const split = splitAriaAuthorityArgs({ lead_id: "l1", _authority: { request_id: "r", correlation_id: "c", idempotency_key: "i" } });
  assert.deepEqual(split.toolArgs, { lead_id: "l1" });
  assert.equal(split.authority.request_id, "r");
});

test("policy responses fail closed on malformed entries", () => {
  assert.throws(() => policyMapFromResponse({ schema_version: "aria-authority-v1", tools: [{ tool_name: "x", risk_tier: "R9" }] }), /Invalid/);
  assert.equal(policyMapFromResponse({ schema_version: "aria-authority-v1", tools: [{ tool_name: "x", risk_tier: "R0" }] }).get("x").risk_tier, "R0");
});

test("R1 project updates expose no redundant approval requirement", () => {
  const projectTool = {
    name: "update_project",
    description: "Update reversible project details",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string" },
        expected_updated_at: { type: "string" },
        address: { type: "string" },
      },
      required: ["project_id", "expected_updated_at"],
      additionalProperties: false,
    },
  };
  const decorated = decorateAriaTool(projectTool, { risk_tier: "R1", action_class: "prepare" });
  assert.match(decorated.description, /No approval is needed/);
  assert.deepEqual(decorated.inputSchema.required, ["project_id", "expected_updated_at", "_authority"]);
});
