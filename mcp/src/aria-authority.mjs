export const FALLBACK_ARIA_READ_TOOLS = new Set([
  "list_projects", "get_project", "list_items", "list_leads", "get_lead_notes",
  "get_needs_attention", "list_invoices", "list_site_photos", "list_pending_transcriptions",
  "list_site_captures", "get_conversation_meeting_source", "list_contacts",
  "list_pending_plan_analyses", "list_office_tasks", "list_design_phases",
  "get_bookings_overdue", "get_ordering_attention", "get_organic_action", "get_proposal",
  "get_email", "search", "get_project_health", "get_context_snapshot",
  "get_materials_needing_aria", "get_stuart_finance_brief",
  "list_learning_candidates",
]);

const AUTHORITY_PROPERTIES = {
  request_id: {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$",
    description: "Trusted request or durable-task id. Copy it from the transport envelope; never invent a human approval.",
  },
  correlation_id: {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$",
    description: "Stable trace id for this workflow.",
  },
  idempotency_key: {
    type: "string",
    pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$",
    description: "Stable key for this exact effect. Reuse only for an exact retry.",
  },
  expected_version: {
    type: "string",
    maxLength: 240,
    description: "Current authoritative version when updating an existing record.",
  },
  expected_absent: {
    type: "boolean",
    description: "Use true for a create-if-absent operation with no prior version.",
  },
  approval_receipt_id: {
    type: "string",
    pattern: "^[0-9a-fA-F-]{36}$",
    description: "Exact unexpired owner approval receipt. Required for R2/R3; never fabricate one.",
  },
};

export function decorateAriaTool(tool, policy) {
  if (!policy || policy.risk_tier === "R0") return tool;
  const approval = policy.risk_tier === "R1"
    ? "No approval is needed for this requested R1 working-state operation."
    : `A matching approval_receipt_id is mandatory for this ${policy.risk_tier} operation.`;
  return {
    ...tool,
    description: `${tool.description}\n\nAuthority: ${policy.risk_tier}/${policy.action_class}. ${approval} The service enforces tenant, exact payload, idempotency and outcome receipts.`,
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...(tool.inputSchema?.properties ?? {}),
        _authority: {
          type: "object",
          properties: AUTHORITY_PROPERTIES,
          required: ["request_id", "correlation_id", "idempotency_key"],
          additionalProperties: false,
        },
      },
      required: [...new Set([...(tool.inputSchema?.required ?? []), "_authority"])],
      additionalProperties: false,
    },
  };
}

export function splitAriaAuthorityArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Tool arguments must be an object");
  const { _authority, ...toolArgs } = args;
  if (!_authority || typeof _authority !== "object" || Array.isArray(_authority)) {
    throw new Error("This operational tool requires the _authority audit envelope");
  }
  return { authority: _authority, toolArgs };
}

export function policyMapFromResponse(response) {
  if (!response || response.schema_version !== "aria-authority-v1" || !Array.isArray(response.tools)) {
    throw new Error("Invalid Aria authority policy response");
  }
  const result = new Map();
  for (const policy of response.tools) {
    if (!policy || typeof policy.tool_name !== "string" || !/^R[0-3]$/.test(policy.risk_tier)) {
      throw new Error("Invalid Aria tool policy entry");
    }
    result.set(policy.tool_name, policy);
  }
  return result;
}
