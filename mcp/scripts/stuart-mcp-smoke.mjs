import { spawn } from "node:child_process";

const child = spawn(process.execPath, [new URL("../src/index.mjs", import.meta.url).pathname], {
  env: process.env,
  stdio: ["pipe", "pipe", "pipe"],
});

const requests = [
  {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "stuart-smoke", version: "1.0.0" },
    },
  },
  { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "get_stuart_finance_brief", arguments: {} },
  },
];

let output = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  output += chunk;
  for (;;) {
    const newline = output.indexOf("\n");
    if (newline < 0) break;
    const line = output.slice(0, newline);
    output = output.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.id === 1) {
      for (const request of requests.slice(1)) child.stdin.write(`${JSON.stringify(request)}\n`);
    }
    if (message.id === 2) {
      process.stdout.write(`${JSON.stringify(message)}\n`);
      child.kill();
    }
  }
});

child.stderr.pipe(process.stderr);
child.stdin.write(`${JSON.stringify(requests[0])}\n`);

setTimeout(() => {
  console.error("Stuart MCP smoke timed out");
  child.kill();
  process.exitCode = 1;
}, 30_000).unref();
