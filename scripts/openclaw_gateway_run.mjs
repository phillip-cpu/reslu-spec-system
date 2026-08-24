#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const PROTOCOL_VERSION = 4;
const DEFAULT_GATEWAY_URL = "ws://127.0.0.1:18789";
const CONNECT_TIMEOUT_MS = 10_000;
const HISTORY_RECONCILE_TIMEOUT_MS = 30_000;
const HISTORY_RECONCILE_INTERVAL_MS = 1_000;
const HISTORY_TIMESTAMP_TOLERANCE_MS = 2_000;
const HISTORY_MESSAGE_LIMIT = 12;
const HISTORY_MAX_CHARS = 220_000;
const MAX_MESSAGE_CHARS = 200_000;
const MAX_IMAGE_ATTACHMENTS = 6;
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]{1,80}\/[A-Za-z0-9._:-]{1,120}$/;
const IMAGE_MIME_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);

function validateImageAttachments(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGE_ATTACHMENTS) throw new Error("Invalid image attachments");
  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      throw new Error(`Invalid image attachment ${index + 1}`);
    }
    const mimeType = typeof attachment.mimeType === "string" ? attachment.mimeType.trim().toLowerCase() : "";
    const fileName = typeof attachment.fileName === "string" ? attachment.fileName.trim() : "";
    const content = typeof attachment.content === "string" ? attachment.content.trim() : "";
    if (!IMAGE_MIME_TYPES.has(mimeType) || !fileName || fileName.length > 240 || !content || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) {
      throw new Error(`Invalid image attachment ${index + 1}`);
    }
    const decodedBytes = Math.floor(content.length * 3 / 4) - (content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0);
    if (decodedBytes < 1 || decodedBytes > MAX_IMAGE_BYTES) throw new Error(`Image attachment ${index + 1} is too large`);
    return { fileName, mimeType, content };
  });
}

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
  if (model && !MODEL_PATTERN.test(model)) throw new Error("Invalid model override");
  const attachments = validateImageAttachments(value.attachments);
  return { message, agentId, sessionKey, idempotencyKey, timeoutSeconds, thinking, model, attachments };
}

export function buildAgentParams(input) {
  const sessionKey = input.sessionKey.startsWith("agent:")
    ? input.sessionKey
    : `agent:${input.agentId}:${input.sessionKey}`;
  return {
    message: input.message,
    agentId: input.agentId,
    sessionKey,
    thinking: input.thinking,
    model: input.model,
    deliver: false,
    timeout: input.timeoutSeconds,
    cleanupBundleMcpOnRunEnd: true,
    idempotencyKey: input.idempotencyKey,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  };
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

const MAX_USAGE_TOKENS = 1_000_000_000;
const MAX_USAGE_COST_USD = 1_000_000;
const SAFE_RUNTIME_LABEL = /^[A-Za-z0-9._:/-]+$/;

function boundedUsageInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_USAGE_TOKENS ? value : null;
}

export function safeOpenClawUsage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const usage = message.usage;
  const provider = typeof message.provider === "string" ? message.provider.trim() : "";
  const model = typeof message.model === "string" ? message.model.trim() : "";
  if (!provider || provider.length > 80 || !SAFE_RUNTIME_LABEL.test(provider)) return null;
  if (!model || model.length > 160 || !SAFE_RUNTIME_LABEL.test(model)) return null;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  const inputTokens = boundedUsageInteger(usage.input);
  const outputTokens = boundedUsageInteger(usage.output);
  const cacheReadTokens = boundedUsageInteger(usage.cacheRead);
  const cacheWriteTokens = boundedUsageInteger(usage.cacheWrite);
  if ([inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens].includes(null)) return null;
  const componentTotal = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const reportedTotal = boundedUsageInteger(usage.totalTokens);
  const totalTokens = reportedTotal ?? (componentTotal <= MAX_USAGE_TOKENS ? componentTotal : null);
  if (totalTokens === null) return null;
  const rawCost = usage.cost && typeof usage.cost === "object" && !Array.isArray(usage.cost)
    ? usage.cost.total
    : null;
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 && rawCost <= MAX_USAGE_COST_USD
    ? Math.round(rawCost * 100_000_000) / 100_000_000
    : null;
  return {
    schema_version: 1,
    provider,
    model,
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cache_read_tokens: cacheReadTokens,
    cache_write_tokens: cacheWriteTokens,
    total_tokens: totalTokens,
    cost_usd: costUsd,
  };
}

export function extractDurableRunResult(history, inputMessage, acceptedAt) {
  if (!history || typeof history !== "object" || !Array.isArray(history.messages)) return null;
  const expected = typeof inputMessage === "string" ? inputMessage.trim() : "";
  const acceptedTimestamp = Number(acceptedAt);
  if (!expected || !Number.isFinite(acceptedTimestamp)) return null;
  const earliestTimestamp = acceptedTimestamp - HISTORY_TIMESTAMP_TOLERANCE_MS;

  for (let index = history.messages.length - 1; index >= 0; index -= 1) {
    const assistantMessage = history.messages[index];
    if (assistantMessage?.role !== "assistant") continue;
    const assistantTimestamp = Number(assistantMessage.timestamp);
    if (!Number.isFinite(assistantTimestamp) || assistantTimestamp < earliestTimestamp) continue;
    const reply = extractChatReply(assistantMessage);
    if (!reply) continue;

    for (let preceding = index - 1; preceding >= 0; preceding -= 1) {
      const userMessage = history.messages[preceding];
      if (userMessage?.role !== "user") continue;
      const userTimestamp = Number(userMessage.timestamp);
      if (!Number.isFinite(userTimestamp) || userTimestamp < earliestTimestamp) break;
      return extractChatReply(userMessage) === expected
        ? { reply, usage: safeOpenClawUsage(assistantMessage) }
        : null;
    }
  }
  return null;
}

export function extractDurableRunReply(history, inputMessage, acceptedAt) {
  return extractDurableRunResult(history, inputMessage, acceptedAt)?.reply ?? null;
}

export function safeAgentEvent(frame, expectedRunId) {
  if (!frame || frame.type !== "event" || !["agent", "chat"].includes(frame.event)) return null;
  const payload = frame.payload;
  if (!payload || payload.runId !== expectedRunId) return null;
  if (frame.event === "chat") {
    if (payload.state === "final") {
      const reply = extractChatReply(payload.message);
      if (!reply) return { type: "error", message: "OpenClaw final event contained no reply" };
      const usage = safeOpenClawUsage(payload.message);
      return usage ? { type: "final", reply, usage } : { type: "final", reply };
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
  let acceptedAt = null;
  let historyReconcileDeadline = null;
  let historyReconcileTimer = null;
  let terminal = false;
  let abortRequested = false;
  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });

  const request = (method, params) => {
    const id = `reslu-${++requestSequence}-${crypto.randomUUID()}`;
    pendingMethods.set(id, method);
    websocket.send(JSON.stringify({ type: "req", id, method, params }));
    return id;
  };

  const clearHistoryReconcileTimer = () => {
    if (historyReconcileTimer) clearTimeout(historyReconcileTimer);
    historyReconcileTimer = null;
  };

  const scheduleHistoryReconcile = (delay = 0) => {
    if (terminal) return;
    if (historyReconcileDeadline === null) historyReconcileDeadline = Date.now() + HISTORY_RECONCILE_TIMEOUT_MS;
    if (Date.now() >= historyReconcileDeadline) {
      closeWithError(new Error("OpenClaw run ended without a durable final response"));
      return;
    }
    clearHistoryReconcileTimer();
    historyReconcileTimer = setTimeout(() => {
      if (terminal || websocket.readyState !== WebSocket.OPEN) return;
      request("chat.history", {
        sessionKey: buildAgentParams(input).sessionKey,
        agentId: input.agentId,
        limit: HISTORY_MESSAGE_LIMIT,
        maxChars: HISTORY_MAX_CHARS,
      });
    }, delay);
  };

  const closeWithError = (reason) => {
    if (terminal) return;
    terminal = true;
    clearHistoryReconcileTimer();
    rejectDone(reason instanceof Error ? reason : new Error(String(reason)));
  };

  const abortRun = () => {
    if (abortRequested || !acceptedRunId || websocket.readyState !== WebSocket.OPEN) return;
    abortRequested = true;
    request("chat.abort", { sessionKey: buildAgentParams(input).sessionKey, runId: acceptedRunId });
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
    if (terminal) return;
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
        if (method === "chat.history" && historyReconcileDeadline !== null) {
          scheduleHistoryReconcile(HISTORY_RECONCILE_INTERVAL_MS);
          return;
        }
        closeWithError(new Error(`OpenClaw Gateway ${method || "request"} failed: ${frame.error?.code || "UNKNOWN"}`));
        return;
      }
      if (method === "chat.history") {
        const result = extractDurableRunResult(frame.payload, input.message, acceptedAt);
        if (result) {
          terminal = true;
          clearHistoryReconcileTimer();
          output({ type: "final", ...result, source: "durable_history" });
          resolveDone(result.reply);
          setTimeout(() => websocket.close(), 0);
        } else {
          scheduleHistoryReconcile(HISTORY_RECONCILE_INTERVAL_MS);
        }
        return;
      }
      if (method === "connect") {
        clearTimeout(connectTimer);
        request("agent", buildAgentParams(input));
        return;
      }
      if (method === "agent") {
        acceptedRunId = typeof frame.payload?.runId === "string" ? frame.payload.runId : input.idempotencyKey;
        acceptedAt = typeof frame.payload?.acceptedAt === "number" ? frame.payload.acceptedAt : Date.now();
        output({
          type: "accepted",
          run_id: acceptedRunId,
          session_key: typeof frame.payload?.sessionKey === "string" ? frame.payload.sessionKey : input.sessionKey,
          accepted_at: acceptedAt,
        });
      }
      return;
    }
    const event = safeAgentEvent(frame, acceptedRunId || input.idempotencyKey);
    if (!event) return;
    output(event);
    if (["final", "error", "aborted"].includes(event.type)) {
      terminal = true;
      clearHistoryReconcileTimer();
      if (event.type === "final") resolveDone(event.reply);
      else rejectDone(new Error(event.message));
      setTimeout(() => websocket.close(), 0);
    } else if (event.type === "lifecycle" && event.phase === "end") {
      scheduleHistoryReconcile();
    } else if (event.type === "lifecycle" && event.phase === "error") {
      closeWithError(new Error("OpenClaw run failed"));
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
    clearHistoryReconcileTimer();
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
