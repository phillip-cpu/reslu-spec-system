import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";

test("existing Stuart MCP tool routes banking and overview reads without adding admin tools", async (t) => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    res.setHeader("content-type", "application/json");
    if (req.url.startsWith("/auth/v1/token?grant_type=password") && req.method === "POST") {
      res.end(JSON.stringify({ access_token: "fixture-access-token", refresh_token: "fixture-refresh-token", expires_in: 3600, token_type: "bearer", user: { id: "00000000-0000-0000-0000-000000000001", email: "accounts@reslu.com.au" } }));
    } else if (req.url.startsWith("/api/stuart/brief?") && req.method === "GET") {
      res.end(JSON.stringify({ fixture: "cached-view", path: req.url }));
    } else {
      res.statusCode = 500; res.end(JSON.stringify({ error: "Unexpected endpoint" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const child = spawn(process.execPath, [new URL("./index.mjs", import.meta.url).pathname], {
    env: { PATH: process.env.PATH, SPEC_URL: base, NEXT_PUBLIC_SUPABASE_URL: base,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "fixture-anon-key", RESLU_AGENT_EMAIL: "accounts@reslu.com.au",
      RESLU_AGENT_PASSWORD: "fixture-password", RESLU_AGENT_ROLE: "stuart" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  const pending = new Map();
  let sequence = 0, buffer = "", stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const pos = buffer.indexOf("\n"), line = buffer.slice(0, pos); buffer = buffer.slice(pos + 1);
      if (!line.trim()) continue;
      const result = JSON.parse(line);
      if (pending.has(result.id)) { pending.get(result.id)(result); pending.delete(result.id); }
    }
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => reject(new Error(`Fixture RPC timed out: ${method}; ${stderr}`)), 10000);
    pending.set(id, (result) => { clearTimeout(timer); resolve(result); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
  const initialized = await call("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "banking-fixture", version: "1.0" } });
  assert.ok(initialized.result);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const listed = await call("tools/list");
  const tools = listed.result.tools;
  const brief = tools.find((tool) => tool.name === "get_stuart_finance_brief");
  assert.deepEqual(brief.inputSchema.properties.section.enum, ["overview", "banking"]);
  assert.equal(brief.inputSchema.properties.limit.maximum, 5);
  assert.equal(tools.some((tool) => /^(list_projects|update_project|xero_sync|xero_connect)$/.test(tool.name)), false);
  for (const [args, path] of [
    [{ section: "banking", offset: 5, limit: 5 }, "/api/stuart/brief?response_format=banking&offset=5&limit=5"],
    [{}, "/api/stuart/brief?response_format=concise"],
  ]) {
    const result = await call("tools/call", { name: "get_stuart_finance_brief", arguments: args });
    assert.equal(result.result.isError, undefined);
    assert.equal(JSON.parse(result.result.content[0].text).path, path);
  }
  assert.deepEqual(requests.map((r) => [r.method, r.url]), [
    ["POST", "/auth/v1/token?grant_type=password"],
    ["GET", "/api/stuart/brief?response_format=banking&offset=5&limit=5"],
    ["GET", "/api/stuart/brief?response_format=concise"],
  ]);
});
