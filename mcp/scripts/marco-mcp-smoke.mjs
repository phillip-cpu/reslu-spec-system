import assert from "node:assert/strict";
import { spawn } from "node:child_process";

const child = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

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
    if (waiter) {
      pending.delete(message.id);
      waiter.resolve(message);
    }
  }
});
child.stderr.pipe(process.stderr);

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 180_000);
    pending.set(id, {
      resolve: (message) => {
        clearTimeout(timeout);
        resolve(message);
      },
    });
  });
}

function toolPayload(message) {
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  assert.equal(message.result?.isError, undefined, JSON.stringify(message.result));
  const text = message.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string", "tool response did not contain text");
  return JSON.parse(text);
}

async function main() {
  const initialized = await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "marco-second-brain-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.error, undefined);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  const listed = await request("tools/list", {});
  const toolNames = listed.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(toolNames, ["add_brain_note", "index_rebuild", "search"]);

  const sourceRef = "marco://workspace/bootstrap/second-brain-integration-v1";
  const note = {
    title: "Marco Second Brain Integration",
    body: "Marco is connected to RESLU Second Brain through a dedicated viewer identity. His bounded tool surface can search curated memory, upsert source-attributed Marco learnings, and reindex memory. Campaign, financial, client-record, and unrelated operational writes remain outside this connection.",
    tags: ["marketing", "marco", "operating-model", "second-brain"],
    source: "marco",
    source_ref: sourceRef,
    confidence: 1,
  };

  const created = toolPayload(await request("tools/call", {
    name: "add_brain_note",
    arguments: note,
  }));
  assert.equal(typeof created.created, "boolean");
  assert.equal(created.note.source, "marco");
  assert.equal(created.note.source_ref, sourceRef);

  const updated = toolPayload(await request("tools/call", {
    name: "add_brain_note",
    arguments: { ...note, body: `${note.body} Stable source references update one node instead of creating duplicates.` },
  }));
  assert.equal(updated.created, false);
  assert.equal(updated.note.id, created.note.id);

  const rejected = await request("tools/call", {
    name: "add_brain_note",
    arguments: { ...note, source: "aria", source_ref: "aria://workspace/forbidden" },
  });
  assert.equal(rejected.result?.isError, true);

  const reindex = toolPayload(await request("tools/call", {
    name: "index_rebuild",
    arguments: { entity_type: "memory" },
  }));
  assert.equal(reindex.phase, "done");

  const search = toolPayload(await request("tools/call", {
    name: "search",
    arguments: { query: "Marco Second Brain Integration", entity_type: "memory", limit: 1, response_format: "concise" },
  }));
  assert.ok(Array.isArray(search.results), `search response missing results: ${JSON.stringify(search)}`);
  assert.ok(search.results.some((result) => result.entity_id === created.note.id));

  process.stdout.write(`${JSON.stringify({
    ok: true,
    tools: toolNames,
    note_upserted: true,
    stable_ref_updated_without_duplicate: true,
    cross_agent_source_rejected: true,
    memory_reindexed: true,
    note_searchable: true,
  })}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => child.kill());
