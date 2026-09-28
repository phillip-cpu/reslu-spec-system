import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Exercise the real MCP entrypoint with fake credentials and unreachable local
// URLs. Listing tools and rejecting unavailable calls must never authenticate.
async function request(role, enabled, method, params = {}, preparationEnabled = "false") {
  const child = spawn(process.execPath, [fileURLToPath(new URL("./index.mjs", import.meta.url))], {
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME,
      SPEC_URL: "http://127.0.0.1:1", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-only-placeholder",
      RESLU_AGENT_EMAIL: "test@example.invalid", RESLU_AGENT_PASSWORD: "test-only-placeholder",
      RESLU_AGENT_ROLE: role, STUART_XERO_CUSTOMER_RECEIPTS_ENABLED: enabled,
      STUART_XERO_CUSTOMER_RECEIPT_PREPARATION_ENABLED: preparationEnabled,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let buffer = "", errors = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`MCP test timed out: ${errors}`)); }, 5000);
    const finish = (error, result) => { clearTimeout(timer); child.kill(); error ? reject(error) : resolve(result); };
    child.on("error", error => finish(error));
    child.on("exit", code => { if (code && code !== 0) finish(new Error(`MCP exited ${code}: ${errors}`)); });
    child.stderr.on("data", chunk => { errors += chunk.toString(); });
    child.stdout.on("data", chunk => {
      buffer += chunk.toString();
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (error) { finish(error); return; }
        if (message.id === 1) {
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
          child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }) + "\n");
        }
        if (message.id === 2) finish(message.error ? new Error(JSON.stringify(message.error)) : null, message.result);
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "receipt-boundary-test", version: "1" } } }) + "\n");
  });
}

test("actual MCP listing exposes receipt tools only to explicitly enabled Stuart", async () => {
  for (const [role, flag, expected] of [["stuart", "false", 0], ["stuart", "true", 2], ["marco", "true", 0]]) {
    const response = await request(role, flag, "tools/list");
    const receipts = response.tools.filter(tool => tool.name.endsWith("stuart_xero_customer_receipts"));
    assert.equal(receipts.length, expected);
    if (expected) {
      const write = receipts.find(tool => tool.name.startsWith("record_"));
      assert.equal(write.inputSchema.properties._authority.required.includes("approval_receipt_id"), true);
    }
  }
});

test("read-only preparation activation never exposes or permits receipt recording", async () => {
  const response = await request("stuart", "false", "tools/list", {}, "true");
  const names = response.tools.map(tool => tool.name);
  assert.equal(names.includes("prepare_stuart_xero_customer_receipts"), true);
  assert.equal(names.includes("record_stuart_xero_customer_receipts"), false);
  const denied = await request("stuart", "false", "tools/call", { name: "record_stuart_xero_customer_receipts", arguments: {} }, "true");
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /Tool is not available/);
  const other = await request("marco", "false", "tools/list", {}, "true");
  assert.equal(other.tools.some(tool => tool.name.endsWith("stuart_xero_customer_receipts")), false);
});

test("calling a hidden receipt tool directly is rejected before any API request", async () => {
  for (const [role, flag] of [["stuart", "false"], ["aria", "true"], ["marco", "true"]]) {
    const response = await request(role, flag, "tools/call", { name: "record_stuart_xero_customer_receipts", arguments: {} });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Tool is not available/);
  }
});
