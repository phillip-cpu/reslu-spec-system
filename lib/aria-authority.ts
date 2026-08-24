import { createHash, randomUUID } from "node:crypto";

export type AriaRiskTier = "R0" | "R1" | "R2" | "R3";

export type AriaAuthorityEnvelope = {
  request_id: string;
  correlation_id: string;
  idempotency_key: string;
  target_type?: string;
  target_id?: string;
  expected_version?: string | null;
  expected_absent?: boolean;
  approval_receipt_id?: string | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const TARGET_KEYS: Record<string, { type: string; keys: string[] }> = {
  create_item: { type: "project", keys: ["project_id"] },
  update_item_status: { type: "item", keys: ["item_id"] },
  update_item_pricing: { type: "item", keys: ["item_id"] },
  create_project: { type: "project", keys: ["client_task_id", "name"] },
  update_project: { type: "project", keys: ["project_id"] },
  move_lead_stage: { type: "lead", keys: ["lead_id"] },
  update_lead: { type: "lead", keys: ["lead_id"] },
  add_lead_note: { type: "lead", keys: ["lead_id"] },
  create_invoice: { type: "project", keys: ["project_id"] },
  propose_supplier_invoice: { type: "email", keys: ["source_email_id"] },
  post_client_update: { type: "project", keys: ["project_id"] },
  draft_diary_entry: { type: "portal_update", keys: ["update_id"] },
  set_capture_transcript: { type: "site_capture", keys: ["capture_id"] },
  get_lead_meeting_recording: { type: "meeting_recording", keys: ["recording_id"] },
  complete_lead_meeting_transcription: { type: "meeting_recording", keys: ["recording_id"] },
  complete_conversation_meeting_draft: { type: "meeting", keys: ["meeting_id"] },
  create_board_task: { type: "project", keys: ["project_id"] },
  submit_plan_analysis: { type: "project_file", keys: ["file_id"] },
  draft_sow_section: { type: "sow_section", keys: ["section_id"] },
  create_client_event: { type: "project", keys: ["project_id"] },
  create_office_task: { type: "project", keys: ["project_id", "lead_id"] },
  create_design_task: { type: "design_phase", keys: ["phase_id"] },
  add_brief_item: { type: "project", keys: ["project_id"] },
  add_brain_note: { type: "memory", keys: ["source_ref", "title"] },
  get_aria_queue: { type: "aria_queue", keys: ["claim_id", "request_id"] },
  resolve_queue_item: { type: "aria_queue", keys: ["id"] },
  submit_organic_action_draft: { type: "organic_action", keys: ["id", "action_id"] },
  submit_followup_draft: { type: "lead", keys: ["lead_id"] },
  complete_followup_send: { type: "followup_draft", keys: ["id"] },
  set_proposal_draft: { type: "proposal", keys: ["id"] },
  index_rebuild: { type: "search_index", keys: ["entity_type", "scope"] },
  approve_proposal: { type: "second_brain_proposal", keys: ["id", "proposal_id"] },
  reject_proposal: { type: "second_brain_proposal", keys: ["id", "proposal_id"] },
  correct_match: { type: "second_brain_match", keys: ["id", "match_id"] },
  book_trade_visit: { type: "trade_visit", keys: ["task_id", "visit_id"] },
  submit_material_price: { type: "material", keys: ["material_id"] },
  add_cpd_entry: { type: "cpd_entry", keys: ["activity_title"] },
  post_heartbeat: { type: "health_heartbeat", keys: ["request_id"] },
  report_channel_status: { type: "health_channel", keys: ["channel"] },
  get_pending_diagnostics: { type: "health_diagnostic", keys: ["request_id"] },
  complete_diagnostic: { type: "health_diagnostic", keys: ["id"] },
  run_stuart_finance_review: { type: "finance_review", keys: ["request_id"] },
  attach_stuart_source_invoice: { type: "invoice", keys: ["invoice_id"] },
  create_stuart_xero_supplier_contact: { type: "invoice", keys: ["invoice_id"] },
  create_stuart_xero_draft_bill: { type: "invoice", keys: ["invoice_id"] },
  commit_company_overhead_finance_intake: { type: "email", keys: ["source_email_id"] },
  reconcile_stuart_supplier_statement: { type: "supplier_statement", keys: ["supplier", "statement_date"] },
  delegate_reslu_agent_task: { type: "conversation", keys: ["conversation_id"] },
  create_learning_candidate: { type: "learning_candidate", keys: ["candidate_key"] },
  add_learning_source: { type: "learning_candidate", keys: ["candidate_id"] },
  record_learning_eval: { type: "learning_candidate", keys: ["candidate_id"] },
  request_learning_review: { type: "learning_candidate", keys: ["candidate_id"] },
  stage_learning_candidate: { type: "learning_candidate", keys: ["candidate_id"] },
  record_learning_monitor: { type: "learning_candidate", keys: ["candidate_id"] },
};

function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Payload contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  throw new Error("Payload contains an unsupported value");
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

export function payloadSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function validatedAuthorityEnvelope(value: unknown): AriaAuthorityEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("_authority must be an object");
  const input = value as Record<string, unknown>;
  for (const key of ["request_id", "correlation_id", "idempotency_key"] as const) {
    if (typeof input[key] !== "string" || !ID.test(input[key])) throw new Error(`Invalid ${key}`);
  }
  if (input.approval_receipt_id != null && (typeof input.approval_receipt_id !== "string" || !UUID.test(input.approval_receipt_id))) {
    throw new Error("Invalid approval_receipt_id");
  }
  if (input.expected_version != null && (typeof input.expected_version !== "string" || input.expected_version.length > 240)) {
    throw new Error("Invalid expected_version");
  }
  if (input.expected_absent != null && typeof input.expected_absent !== "boolean") throw new Error("Invalid expected_absent");
  return {
    request_id: input.request_id as string,
    correlation_id: input.correlation_id as string,
    idempotency_key: input.idempotency_key as string,
    target_type: typeof input.target_type === "string" ? input.target_type : undefined,
    target_id: typeof input.target_id === "string" ? input.target_id : undefined,
    expected_version: typeof input.expected_version === "string" ? input.expected_version : null,
    expected_absent: input.expected_absent === true,
    approval_receipt_id: typeof input.approval_receipt_id === "string" ? input.approval_receipt_id : null,
  };
}

export function deriveActionTarget(
  toolName: string,
  args: Record<string, unknown>,
  envelope?: Partial<AriaAuthorityEnvelope>,
): { target_type: string; target_id: string } {
  const rule = TARGET_KEYS[toolName];
  if (rule) {
    const values = rule.keys
      .map((key) => args[key])
      .filter((value): value is string | number => typeof value === "string" || typeof value === "number")
      .map(String)
      .filter(Boolean);
    if (values.length) return { target_type: rule.type, target_id: values.join(":").slice(0, 240) };
  }
  if (envelope?.target_type && envelope.target_id) {
    if (!ID.test(envelope.target_type) || envelope.target_id.length > 240) throw new Error("Invalid explicit action target");
    return { target_type: envelope.target_type, target_id: envelope.target_id };
  }
  return { target_type: "action", target_id: `${toolName}:${randomUUID()}` };
}

function findObjectIdentity(value: unknown): { id?: string; version?: string; status?: string } {
  if (!value || typeof value !== "object") return {};
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectIdentity(item);
      if (found.id) return found;
    }
    return {};
  }
  const record = value as Record<string, unknown>;
  const id = [record.id, record.uuid, record.record_id, record.booking_id, record.provider_id]
    .find((item) => typeof item === "string") as string | undefined;
  const version = [record.version, record.updated_at, record.created_at, record.receipt_id]
    .find((item) => typeof item === "string" || typeof item === "number");
  const status = typeof record.status === "string" ? record.status : undefined;
  if (id) return { id, version: version == null ? undefined : String(version), status };
  for (const item of Object.values(record)) {
    const found = findObjectIdentity(item);
    if (found.id) return found;
  }
  return {};
}

export function verificationFromResult(
  toolName: string,
  verificationKind: string,
  result: unknown,
): {
  outcome: "verified" | "partial";
  receipt_ref: string | null;
  result_sha256: string;
  resulting_version: string | null;
  verification_kind: string;
  verification_evidence: Record<string, unknown>;
} {
  const digest = payloadSha256(result);
  const identity = findObjectIdentity(result);
  if (verificationKind === "none" || !identity.id) {
    return {
      outcome: "partial",
      receipt_ref: null,
      result_sha256: digest,
      resulting_version: identity.version ?? null,
      verification_kind: "none",
      verification_evidence: { reason: identity.id ? "no_verifier" : "missing_authoritative_identity" },
    };
  }
  if (verificationKind === "draft_record") {
    const prohibited = /^(sent|published|paid|approved|completed)$/i.test(identity.status ?? "");
    if (prohibited) {
      return {
        outcome: "partial",
        receipt_ref: null,
        result_sha256: digest,
        resulting_version: identity.version ?? null,
        verification_kind: "none",
        verification_evidence: { reason: "draft_tool_returned_consequential_status" },
      };
    }
  }
  return {
    outcome: "verified",
    receipt_ref: `reslu://${verificationKind}/${toolName}/${identity.id}`,
    result_sha256: digest,
    resulting_version: identity.version ?? identity.status ?? identity.id,
    verification_kind: verificationKind,
    verification_evidence: { authoritative_id: identity.id, status: identity.status ?? null },
  };
}
