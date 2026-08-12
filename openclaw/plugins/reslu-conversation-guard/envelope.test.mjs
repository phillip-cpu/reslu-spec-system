import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { clearBridgeEnvelope, loadBridgeEnvelope, persistBridgeEnvelope } from "./envelope.mjs";

test("persists a signed short-lived bridge envelope across process-local state", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reslu-envelope-"));
  process.env.RESLU_CONVERSATION_ENVELOPE_DIR = root;
  const input = { sessionKey: "agent:stuart:reslu-conversation-v2-test", runId: "run-1", mode: "human_request", workspaceDir: "/Users/vale/.openclaw/workspace-stuart" };
  assert.deepEqual(persistBridgeEnvelope(input, 1_000, 60_000), { mode: "human_request", workspaceDir: input.workspaceDir });
  assert.deepEqual(loadBridgeEnvelope(input.sessionKey, 2_000), { mode: "human_request", workspaceDir: input.workspaceDir });
  clearBridgeEnvelope(input.sessionKey, "different-run");
  assert.ok(loadBridgeEnvelope(input.sessionKey, 2_000));
  clearBridgeEnvelope(input.sessionKey, input.runId);
  assert.equal(loadBridgeEnvelope(input.sessionKey, 2_000), null);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.RESLU_CONVERSATION_ENVELOPE_DIR;
});

test("rejects expired or tampered envelopes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reslu-envelope-"));
  process.env.RESLU_CONVERSATION_ENVELOPE_DIR = root;
  const input = { sessionKey: "agent:stuart:reslu-conversation-v2-test-2", runId: "run-2", mode: "forwarded_context", workspaceDir: "/Users/vale/.openclaw/workspace-stuart" };
  persistBridgeEnvelope(input, 10_000, 1_000);
  assert.equal(loadBridgeEnvelope(input.sessionKey, 11_001), null);
  persistBridgeEnvelope(input, 20_000, 1_000);
  const file = fs.readdirSync(root).find((name) => name.endsWith(".json"));
  const record = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
  record.mode = "human_request";
  fs.writeFileSync(path.join(root, file), JSON.stringify(record), { mode: 0o600 });
  assert.equal(loadBridgeEnvelope(input.sessionKey, 20_500), null);
  fs.rmSync(root, { recursive: true, force: true });
  delete process.env.RESLU_CONVERSATION_ENVELOPE_DIR;
});
