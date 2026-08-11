#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 4;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const CONNECT_TIMEOUT_MS = 10_000;
const FINAL_EVENT_GRACE_MS = 5_000;
const MAX_MESSAGE_CHARS = 200_000;

export function validateGatewayUrl(raw) {
  const url = new URL(raw || DEFAULT_GATEWAY_URL);
  if (url.protocol !== "ws:" || !["127.0.0.1", "localhost", "::1"].includes(url.hostname)) {
    throw new Error("RESLU OpenClaw Gateway must remain on loopback ws:// transport");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Invalid RESLU OpenClaw Gateway URL");
  }
  return url.toString();
}

export function validateRunInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Run input must be an object");
  const message = typeof value.message === "string" ? value.message.trim() : "";
  const agentId = typeof value.agentId === "string" ? value.agentId.trim() : "";
  const sessionKey = typeof value.sessionKey === "string" ? value.sessionKey.trim() : "";
  const idempotencyKey = typeof value.idempotencyKey === "string" ? value.idempotencyKey.trim() : "";
  if (!message || message.length > MAX_MESSAGE_CHARS) throw new Error("Run message is missing or too large");
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) throw new Error("Invalid agent id");
  if (!/^[A-Za-z0-9:_-]{1,240}$/.test(sessionKey)) throw new Error("Invalid session key");
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(idempotencyKey)) throw new Error("Invalid idempotency key");
  const timeoutSeconds = Number(value.timeoutSeconds);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
    throw new Error("Invalid run timeout");
  }
  const thinking = typeof value.thinking === "string" && value.thinking ? value.thinking : undefined;
  const model = typeof value.model === "string" && value.model.trim() ? value.model.trim() : undefined;
  return { message, agentId, sessionKey, idempotencyKey, timeoutSeconds, thinking, model };
}

export function extractChatReply(message) {
  if (typeof message === "string") return message.trim() || null;
  if (!message || typeof message !== "object") return null;
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  if (typeof message.content === "string" && message.content.trim()) return message.content.trim();
  if (!Array.isArray(message.content)) return null;
  const parts = message.content
    .filter((part) => part && typeof part === "object" && [undefined, "text", "output_text"].includes(part.type))
    .map((part) => typeof part.text === "string" ? part.text.trim() : "")
    .filter(Boolean);
  return parts.join("\n\n") || null;
}

export function safeAgentEvent(frame, expectedRunId) {
  if (!frame || frame.type !== "event" || !["agent", "chat"].includes(frame.event)) return null;
  const payload = frame.payload;
  if (!payload || payload.runId !== expectedRunId) return null;
  if (frame.event === "chat") {
    if (payload.state === "final") {
      const reply = extractChatReply(payload.message);
      return reply ? { type: "final", reply } : { type: "error", message: "OpenClaw final event contained no reply" };
    }
    if (payload.state === "aborted") return { type: "aborted", message: "OpenClaw run was cancelled" };
    if (payload.state === "error") return { type: "error", message: "OpenClaw run failed" };
    return null;
  }
  const data = payload.data && typeof payload.data === "object" ? payload.data : {};
  if (payload.stream === "lifecycle" && typeof data.phase === "string") {
    return { type: "lifecycle", phase: data.phase.slice(0, 80) };
  }
  if (payload.stream === "tool") {
    return {
      type: "tool",
      phase: typeof data.phase === "string" ? data.phase.slice(0, 80) : null,
      name: typeof data.name === "string" ? data.name.slice(0, 160) : null,
      tool_call_id: typeof data.toolCallId === "string" ? data.toolCallId.slice(0, 200) : null,
    };
  }
  if (payload.stream === "assistant" && typeof data.delta === "string" && data.delta.length > 0) {
    return { type: "assistant_delta", character_count: data.delta.length };
  }
  return null;
}

function readGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  const configPath = process.env.OPENCLAW_CONFIG_PATH || `${process.env.HOME}/.openclaw/openclaw.json`;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const token = config.gateway?.auth?.token;
  if (typeof token !== "string" || !token) throw new Error("OpenClaw Gateway token is unavailable");
  return token;
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return validateRunInput(JSON.parse(raw));
}

export async function runGatewayAgent(input, options = {}) {
  const token = options.token || readGatewayToken();
  const gatewayUrl = validateGatewayUrl(options.url || process.env.RESLU_OPENCLAW_GATEWAY_URL || DEFAULT_GATEWAY_URL);
  const output = options.emit || emit;
  const websocket = options.websocket || new WebSocket(gatewayUrl);
  const pendingMethods = new Map();
  let requestSequence = 0;
  let acceptedRunId = null;
  let terminal = false;
  let abortRequested = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const request = (method, params) => {
    const id = `reslu-${++requestSequence}-${crypto.randomUUID()}`;
    pendingMethods.set(id, method);
    websocket.send(JSON.stringify({ type: "req", id, method, params }));
  };

  const closeWithError = (reason) => {
    if (terminal) return;
    terminal = true;
    rejectDone(reason instanceof Error ? reason : new Error(String(reason)));
  };

  const abortRun = () => {
    if (abortRequested || !acceptedRunId || websocket.readyState !== WebSocket.OPEN) return;
    abortRequested = true;
    request("chat.abort", { sessionKey: input.sessionKey, runId: acceptedRunId });
  };

  const connectTimer = setTimeout(() => closeWithError(new Error("OpenClaw Gateway connect timed out")), CONNECT_TIMEOUT_MS);
  const runTimer = setTimeout(() => {
    abortRun();
    closeWithError(new Error("OpenClaw Gateway run timed out"));
  }, input.timeoutSeconds * 1000 + CONNECT_TIMEOUT_MS);

  const handleSignal = () => {
    abortRun();
    setTimeout(() => {
      closeWithError(new Error("OpenClaw Gateway run cancelled"));
      websocket.close();
    }, 250).unref?.();
  };
  process.once("SIGTERM", handleSignal);
  process.once("SIGINT", handleSignal);

  websocket.onmessage = (message) => {
    let frame;
    try { frame = JSON.parse(message.data); } catch { return; }
    if (frame.type === "event" && frame.event === "connect.challenge") {
      request("connect", {
        minProtocol: PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: {
          id: "gateway-client",
          displayName: "RESLU conversation bridge",
          version: "1",
          platform: process.platform,
          mode: "backend",
        },
        role: "operator",
        scopes: ["operator.admin"],
        caps: ["tool-events"],
        commands: [],
        permissions: {},
        auth: { token },
        locale: "en-AU",
        userAgent: "reslu-conversation-bridge/1",
      });
      return;
    }
    if (frame.type === "res") {
      const method = pendingMethods.get(frame.id);
      pendingMethods.delete(frame.id);
      if (!frame.ok) {
        if (method === "chat.abort" && abortRequested) return;
        closeWithError(new Error(`OpenClaw Gateway ${method || "request"} failed: ${frame.error?.code || "UNKNOWN"}`));
        return;
      }
      if (method === "connect") {
        clearTimeout(connectTimer);
        request("agent", {
          message: input.message,
          agentId: input.agentId,
          sessionKey: input.sessionKey,
          thinking: input.thinking,
          model: input.model,
          deliver: false,
          timeout: input.timeoutSeconds,
          cleanupBundleMcpOnRunEnd: true,
          idempotencyKey: input.idempotencyKey,
        });
        return;
      }
      if (method === "agent") {
        acceptedRunId = typeof frame.payload?.runId === "string" ? frame.payload.runId : input.idempotencyKey;
        output({
          type: "accepted",
          run_id: acceptedRunId,
          session_key: typeof frame.payload?.sessionKey === "string" ? frame.payload.sessionKey : input.sessionKey,
          accepted_at: typeof frame.payload?.acceptedAt === "number" ? frame.payload.acceptedAt : Date.now(),
        });
      }
      return;
    }
    const event = safeAgentEvent(frame, acceptedRunId || input.idempotencyKey);
    if (!event) return;
    output(event);
    if (["final", "error", "aborted"].includes(event.type)) {
      terminal = true;
      if (event.type === "final") resolveDone(event.reply);
      else rejectDone(new Error(event.message));
      setTimeout(() => websocket.close(), 0);
    } else if (event.type === "lifecycle" && ["end", "error"].includes(event.phase)) {
      setTimeout(() => {
        if (!terminal) closeWithError(new Error("OpenClaw run ended without a final chat event"));
      }, FINAL_EVENT_GRACE_MS);
    }
  };
  websocket.onerror = () => closeWithError(new Error("OpenClaw Gateway connection failed"));
  websocket.onclose = () => {
    if (!terminal) closeWithError(new Error("OpenClaw Gateway connection closed before the final response"));
  };

  try {
    return await done;
  } finally {
    clearTimeout(connectTimer);
    clearTimeout(runTimer);
    process.removeListener("SIGTERM", handleSignal);
    process.removeListener("SIGINT", handleSignal);
    try { websocket.close(); } catch { /* already closed */ }
  }
}

async function main() {
  let accepted = false;
  try {
    const input = await readStdinJson();
    await runGatewayAgent(input, {
      emit(value) {
        if (value.type === "accepted") accepted = true;
        emit(value);
      },
    });
  } catch (error) {
    emit({ type: "fatal", accepted, message: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
