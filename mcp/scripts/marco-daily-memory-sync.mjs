import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const date = new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const memoryPath = `/Users/vale/.openclaw/workspace-marco/memory/${date}.md`;
const memory = readFileSync(memoryPath, "utf8").slice(0, 9_500);
const config = JSON.parse(readFileSync("/Users/vale/.openclaw/openclaw.json", "utf8"));
const server = config.mcp?.servers?.["reslu-marco"];
assert.ok(server?.command && Array.isArray(server.args) && server.env, "reslu-marco MCP registration is missing");

const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1;
let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  }
});
child.stderr.pipe(process.stderr);

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 180_000);
    pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  });
}

function payload(message) {
  assert.equal(message.result?.isError, undefined, JSON.stringify(message.result));
  const text = message.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function main() {
  await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "marco-daily-memory-sync", version: "1.0.0" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);
  const note = payload(await request("tools/call", { name: "add_brain_note", arguments: {
    title: `Marco Marketing Memory — ${date}`, body: memory,
    tags: ["marketing", "marco", "daily-memory", "google-ads"], source: "marco",
    source_ref: `marco://workspace/memory/${date}.md`, confidence: 0.95,
  }}));
  const reindex = payload(await request("tools/call", { name: "index_rebuild", arguments: { entity_type: "memory" } }));
  process.stdout.write(`${JSON.stringify({ ok: true, adelaide_date: date, note_id: note.note.id, created: note.created, source_ref: note.note.source_ref, reindex_phase: reindex.phase })}\n`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }).finally(() => child.kill());
