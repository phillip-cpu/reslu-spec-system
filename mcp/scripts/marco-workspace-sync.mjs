import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const workspace = "/Users/vale/Documents/Codex/2026-08-13/marco-santoro-skills-i-want-to";
const publications = [
  {
    path: "docs/marco-agent-charter.md",
    title: "Marco Agent Charter",
    tags: ["marketing", "marco", "governance", "operating-model"],
  },
  {
    path: "docs/marco-a1-roadmap.md",
    title: "Marco A1 Development Roadmap",
    tags: ["marketing", "marco", "education", "roadmap"],
  },
  {
    path: "docs/marco-education-curriculum.md",
    title: "Marco Marketing Education Curriculum",
    tags: ["marketing", "marco", "education", "curriculum"],
  },
  {
    path: "docs/marco-runtime-contract.md",
    title: "Marco Runtime Contract",
    tags: ["marketing", "marco", "governance", "runtime"],
  },
  {
    path: "registry/marco-skill-registry.json",
    title: "Marco Skill Registry",
    tags: ["marketing", "marco", "skills", "registry"],
  },
];

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
      waiter(message);
    }
  }
});
child.stderr.pipe(process.stderr);

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 180_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}

function payload(message) {
  assert.equal(message.result?.isError, undefined, JSON.stringify(message.result));
  const text = message.result?.content?.find((item) => item.type === "text")?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text);
}

async function main() {
  await request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "marco-workspace-sync", version: "1.0.0" },
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`);

  const results = [];
  for (const publication of publications) {
    const body = readFileSync(`${workspace}/${publication.path}`, "utf8").slice(0, 9_500);
    const response = payload(await request("tools/call", {
      name: "add_brain_note",
      arguments: {
        title: publication.title,
        body,
        tags: publication.tags,
        source: "marco",
        source_ref: `marco://workspace/${publication.path}`,
        confidence: 1,
      },
    }));
    results.push({ path: publication.path, note_id: response.note.id, created: response.created });
  }

  payload(await request("tools/call", { name: "index_rebuild", arguments: { entity_type: "memory" } }));
  const found = payload(await request("tools/call", {
    name: "search",
    arguments: { query: "Marco A1 Development Roadmap", entity_type: "memory", limit: 1, response_format: "concise" },
  }));
  assert.ok(found.results?.some((result) => result.title === "Marco A1 Development Roadmap"));

  process.stdout.write(`${JSON.stringify({ ok: true, publications: results, reindexed: true, roadmap_searchable: true })}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => child.kill());
