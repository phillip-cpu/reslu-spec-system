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
const DELEGATION_TOOL_SUFFIX = "delegate_reslu_agent_task";
const HUMAN_AGENT_COORDINATION_TOOLS = new Set([
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
]);
// MCP tools use double underscores in OpenClaw's native tool surface and dots
// in the Codex app-server surface. Accept both representations so the same
// authenticated human authority envelope survives a model-runtime change.
const HUMAN_OPERATION_PREFIXES = [
  "reslu-spec__",
  "reslu-spec.",
  "gsc__",
  "gsc.",
  "gads__",
  "gads.",
  "meta-ads__",
  "meta-ads.",
  "reslu-site__",
  "reslu-site.",
  // Codex app-server exposes bundled MCP calls with an `mcp__` prefix and
  // normalizes hyphens in server ids to underscores.
  "mcp__reslu_spec__",
  "mcp__gsc__",
  "mcp__gads__",
  "mcp__meta_ads__",
  "mcp__reslu_site__",
];
const HUMAN_TYPED_SPECIALIST_TOOLS = new Set([
  "reslu-marco__add_brain_note",
  "reslu-marco.add_brain_note",
  "mcp__reslu_marco__add_brain_note",
  "reslu-marco__index_rebuild",
  "reslu-marco.index_rebuild",
  "mcp__reslu_marco__index_rebuild",
  "reslu-marco__delegate_reslu_agent_task",
  "reslu-stuart__delegate_reslu_agent_task",
]);
// Stuart's only direct-human finance writes are purpose-built, server-guarded
// workflow steps: link already-ingested source evidence, create a verified
// supplier contact without bank details, and create a Xero DRAFT.
// Keep this exact-name allowlist narrow; it must not become a general
// `reslu-stuart__` prefix because payments, approvals and master-data writes
// must remain structurally unavailable.
const HUMAN_STUART_OPERATION_TOOLS = new Set([
  "reslu-stuart__attach_stuart_source_invoice",
  "reslu-stuart__create_stuart_xero_supplier_contact",
  "reslu-stuart__create_stuart_xero_draft_bill",
]);
// Marco may author and publish RESLU content through the authenticated Sanity
// MCP connection. Keep this list explicit so destructive draft/version discard,
// project administration, CORS changes, and unrestricted CLI execution remain
// unavailable from a direct conversation.
const HUMAN_SANITY_OPERATION_TOOLS = new Set([
  "sanity__create_documents",
  "sanity__create_release",
  "sanity__create_version",
  "sanity__dataset_assets_upload",
  "sanity__generate_image",
  "sanity__get_document",
  "sanity__get_schema",
  "sanity__list_datasets",
  "sanity__list_projects",
  "sanity__list_releases",
  "sanity__list_workspace_schemas",
  "sanity__patch_documents",
  "sanity__publish_documents",
  "sanity__query_documents",
  "sanity__resources_list",
  "sanity__resources_read",
  "sanity__semantic_search",
  "sanity__transform_image",
  "sanity__whoami",
]);
// Authenticated direct human requests may use the bounded research surfaces.
// Browser remains unavailable to forwarded content, attachments and specialist
// consultations because those modes return before this allowlist is reached.
const HUMAN_RESEARCH_TOOLS = new Set(["web_search", "web_fetch", "browser"]);
const HUMAN_GMAIL_OPERATION_TOOLS = new Set(["reslu_gmail_messages_send"]);
const HUMAN_MARCO_OFFICE_TOOLS = new Set([
  "reslu-lifecycle__create_office_task",
  "reslu-lifecycle.create_office_task",
  "reslu_lifecycle.create_office_task",
  "mcp__reslu_lifecycle__create_office_task",
]);
const ARIA_SKILL_DIRS = new Set([
  "aria-operating-loop",
  "aria-continuous-education",
  "aria-evaluate-skills",
  "aria-reflect",
  "doc-package",
  "ics-reader",
  "img-reader",
  "reslu-email",
  "reslu-inbox",
  "reslu-nurturer",
  "reslu-radar",
  "reslu-site-brief",
  "reslu-site-lookup",
  "reslu-weather-sync",
  "sentiment-analytics",
  "web-form",
  "web-reader",
  "word-docx",
  "xlsx-reader",
]);

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

function isSafeAriaSkillRead(event, workspaceDir) {
  if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) return false;
  const requested = event?.params?.path ?? event?.params?.file_path;
  if (typeof requested !== "string" || !requested.trim()) return false;
  const resolved = path.resolve(workspaceDir, requested);
  for (const skill of ARIA_SKILL_DIRS) {
    const root = path.resolve(workspaceDir, "skills", skill);
    if (resolved === path.join(root, "SKILL.md") || isInside(root, resolved)) return true;
  }
  return false;
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

  // Typed specialist delegation remains available alongside generic agent
  // coordination. The API authenticates the calling RESLU agent, validates
  // membership, creates one bounded specialist task and preserves normal
  // approval rules. Generic spawning may target any installed agent; the
  // delegated task's authority envelope, not an agent-name allowlist, bounds it.
  if (state.mode === "human_request" && toolName.endsWith(DELEGATION_TOOL_SUFFIX)) {
    return undefined;
  }

  // A direct request from the authenticated human is an operational turn,
  // not an untrusted read-only document. Aria may use Reslu business tools
  // and coordinate agents; the operating policy and each tool's own approval
  // contract continue to govern consequential actions. Forwarded content,
  // attachments and specialist consultations never receive this authority.

  if (state.mode === "human_request" && (
    HUMAN_AGENT_COORDINATION_TOOLS.has(toolName)
    || HUMAN_TYPED_SPECIALIST_TOOLS.has(toolName)
    || HUMAN_STUART_OPERATION_TOOLS.has(toolName)
    || HUMAN_SANITY_OPERATION_TOOLS.has(toolName)
    || HUMAN_GMAIL_OPERATION_TOOLS.has(toolName)
    || HUMAN_MARCO_OFFICE_TOOLS.has(toolName)
    || HUMAN_RESEARCH_TOOLS.has(toolName)
    || HUMAN_OPERATION_PREFIXES.some((prefix) => toolName.startsWith(prefix))
  )) {
    return undefined;
  }

  if (state.mode === "human_request" && toolName === "read" && isSafeAriaSkillRead(event, state.workspaceDir)) {
    return undefined;
  }

  if (BLOCKED_TOOL_NAMES.has(toolName) || MUTATION_TOKEN.test(toolName)) {
    return blocked("Direct RESLU conversation turns cannot mutate systems or access host runtime/files");
  }

  if (SAFE_BUILTIN_READ_TOOLS.has(toolName) || READ_ONLY_TOKEN.test(toolName)) {
    return undefined;
  }

  return blocked("RESLU conversation tool is not on the read-only business allowlist");
}
