import path from "node:path";

const CONVERSATION_SESSION = /(?:^|:)reslu-conversation-[A-Za-z0-9_-]+-/;
const BRIDGE_MARKERS = {
  requestStart: "CURRENT_REQUEST_JSON\n",
  requestEnd: "\nEND_CURRENT_REQUEST_JSON",
  attachmentsStart: "ATTACHMENTS_FOR_NEWEST_MESSAGE_JSON\n",
  attachmentsEnd: "\nEND_ATTACHMENTS_FOR_NEWEST_MESSAGE_JSON",
};

const BLOCKED_TOOL_NAMES = new Set([
  "apply_patch",
  "browser",
  "canvas",
  "code_execution",
  "codex_threads",
  "create_goal",
  "cron",
  "edit",
  "exec",
  "gateway",
  "image_generate",
  "message",
  "music_generate",
  "nodes",
  "process",
  "read",
  "sessions_history",
  "sessions_list",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "skill_workshop",
  "subagents",
  "update_goal",
  "update_plan",
  "video_generate",
  "web_fetch",
  "web_search",
  "whatsapp_call",
  "write",
  "x_search",
]);

const MUTATION_TOKEN = /(?:^|[_-])(?:add|apply|approve|archive|book|cancel|create|delete|edit|forward|grant|invite|pay|post|publish|remove|revoke|schedule|send|share|spend|submit|update|upload|write)(?:[_-]|$)/i;
const READ_ONLY_TOKEN = /(?:^|[_-])(?:check|describe|find|get|inspect|list|lookup|read|search|status|view)(?:[_-]|$)/i;
const SAFE_BUILTIN_READ_TOOLS = new Set(["memory_get", "memory_search", "session_status"]);

function extractJsonSection(prompt, startMarker, endMarker) {
  const start = prompt.indexOf(startMarker);
  if (start < 0) return null;
  const payloadStart = start + startMarker.length;
  const end = prompt.indexOf(endMarker, payloadStart);
  if (end < 0) return null;
  try {
    return JSON.parse(prompt.slice(payloadStart, end));
  } catch {
    return null;
  }
}

export function isResluConversationSession(sessionKey) {
  return typeof sessionKey === "string" && CONVERSATION_SESSION.test(sessionKey);
}

export function classifyResluConversationPrompt(prompt) {
  if (typeof prompt !== "string") return null;
  const request = extractJsonSection(prompt, BRIDGE_MARKERS.requestStart, BRIDGE_MARKERS.requestEnd);
  const attachments = extractJsonSection(
    prompt,
    BRIDGE_MARKERS.attachmentsStart,
    BRIDGE_MARKERS.attachmentsEnd,
  );
  if (!request || typeof request !== "object" || Array.isArray(request) || !Array.isArray(attachments)) {
    return null;
  }
  if (!["human_request", "forwarded_context", "specialist_consultation"].includes(request.kind)) {
    return null;
  }
  if (request.kind === "forwarded_context") return "forwarded_context";
  if (attachments.length > 0) return "attachment_review";
  return request.kind;
}

function attachmentRoot(workspaceDir) {
  if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) return null;
  return path.resolve(workspaceDir, ".reslu-conversation-attachments");
}

function isInside(root, candidate) {
  if (!root || typeof candidate !== "string" || !path.isAbsolute(candidate)) return false;
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function collectStringValues(value, output = []) {
  if (typeof value === "string") output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStringValues(item, output));
  else if (value && typeof value === "object") {
    Object.values(value).forEach((item) => collectStringValues(item, output));
  }
  return output;
}

function attachmentPaths(event) {
  return [
    ...(Array.isArray(event?.derivedPaths) ? event.derivedPaths : []),
    ...collectStringValues(event?.params),
  ].filter((value) => typeof value === "string" && path.isAbsolute(value));
}

function isSafeAttachmentRead(event, workspaceDir) {
  const root = attachmentRoot(workspaceDir);
  const paths = attachmentPaths(event);
  return paths.length > 0 && paths.every((candidate) => isInside(root, candidate));
}

function blocked(reason) {
  return {
    block: true,
    blockReason: reason,
  };
}

export function evaluateResluConversationTool(event, context, runState) {
  if (!isResluConversationSession(context?.sessionKey)) return undefined;
  const state = runState ?? null;
  if (!state) return blocked("RESLU conversation run has no validated bridge envelope");

  const toolName = String(event?.toolName ?? context?.toolName ?? "").trim().toLowerCase();
  if (!toolName) return blocked("RESLU conversation requested an unidentified tool");

  if (state.mode === "forwarded_context") {
    return blocked("Forwarded RESLU content is evidence only and cannot invoke tools");
  }

  if (state.mode === "attachment_review") {
    if (toolName === "reslu_attachment_pdf_text_read" && isSafeAttachmentRead(event, state.workspaceDir)) {
      return undefined;
    }
    if (["read", "image"].includes(toolName) && isSafeAttachmentRead(event, state.workspaceDir)) {
      return undefined;
    }
    return blocked("Attachment review is restricted to its private staged files");
  }

  if (BLOCKED_TOOL_NAMES.has(toolName) || MUTATION_TOKEN.test(toolName)) {
    return blocked("Direct RESLU conversation turns cannot mutate systems or access host runtime/files");
  }

  if (SAFE_BUILTIN_READ_TOOLS.has(toolName) || READ_ONLY_TOKEN.test(toolName)) {
    return undefined;
  }

  return blocked("RESLU conversation tool is not on the read-only business allowlist");
}
