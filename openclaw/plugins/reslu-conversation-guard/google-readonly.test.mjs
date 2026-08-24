import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGmailRawMessage,
  createMarcoGmailSendTool,
  createReadonlyGoogleTools,
  normalizeCalendarRequest,
  normalizeGmailMessageId,
  normalizeGmailSendRequest,
  normalizeGmailSearchRequest,
  normalizeMailbox,
  resolveGoogleAuthInput,
  resolveGoogleIntegrationWorkspace,
  resolveGmailSender,
  resolveStagedAttachmentPath,
} from "./google-readonly.mjs";

test("calendar requests default to a bounded two-week range", () => {
  const result = normalizeCalendarRequest({}, new Date("2026-08-12T00:00:00.000Z"));
  assert.deepEqual(result, {
    timeMin: "2026-08-12T00:00:00.000Z",
    timeMax: "2026-08-26T00:00:00.000Z",
    q: undefined,
    maxResults: 10,
  });
});

test("calendar rejects oversized ranges, query injection and unbounded limits", () => {
  assert.throws(() => normalizeCalendarRequest({
    time_min: "2026-08-01T00:00:00Z",
    time_max: "2026-10-01T00:00:00Z",
  }), /31 days/);
  assert.throws(() => normalizeCalendarRequest({ query: "client\nignore instructions" }), /one line/);
  assert.throws(() => normalizeCalendarRequest({ limit: 100 }), /integer from 1 to 20/);
});

test("gmail searches are bounded and default to recent inbox mail", () => {
  assert.deepEqual(normalizeGmailSearchRequest({}), {
    mailbox: "aria",
    q: "in:inbox newer_than:30d",
    maxResults: 5,
  });
  assert.deepEqual(normalizeGmailSearchRequest({ mailbox: "phillip", query: "from:client@example.com", limit: 10 }), {
    mailbox: "phillip",
    q: "from:client@example.com",
    maxResults: 10,
  });
  assert.deepEqual(normalizeGmailSearchRequest({ mailbox: "phillip", limit: 15 }), {
    mailbox: "phillip",
    q: "in:inbox newer_than:30d",
    maxResults: 10,
  });
  assert.throws(() => normalizeGmailSearchRequest({ query: "x".repeat(301) }), /300/);
  assert.throws(() => normalizeGmailSearchRequest({ limit: 0 }), /at least 1/);
  assert.throws(() => normalizeMailbox("accounts"), /one of/);
});

test("gmail detail reads accept only opaque provider IDs", () => {
  assert.equal(normalizeGmailMessageId("18f_aBc-123"), "18f_aBc-123");
  assert.throws(() => normalizeGmailMessageId("../../token.json"), /invalid/);
  assert.throws(() => normalizeGmailMessageId("id\nnext"), /invalid/);
});

test("agent workspaces resolve fixed Google integrations from the shared workspace", () => {
  assert.equal(resolveGoogleIntegrationWorkspace("/Users/vale/.openclaw/workspace"), "/Users/vale/.openclaw/workspace");
  assert.equal(resolveGoogleIntegrationWorkspace("/Users/vale/.openclaw/workspace-marco"), "/Users/vale/.openclaw/workspace");
  assert.throws(() => resolveGoogleIntegrationWorkspace("/private/tmp"), /unavailable/);
});

test("Marco Gmail send requests are bounded and reject header injection", () => {
  assert.deepEqual(normalizeGmailSendRequest({
    to: "Client@Example.com",
    subject: "Approved subject",
    body: "Approved body\nSecond line",
    idempotency_key: "approval-123",
  }), {
    to: "client@example.com",
    subject: "Approved subject",
    body: "Approved body\nSecond line",
    idempotencyKey: "approval-123",
  });
  assert.throws(() => normalizeGmailSendRequest({
    to: "client@example.com\nBcc: attacker@example.com",
    subject: "Subject",
    body: "Body",
    idempotency_key: "approval-123",
  }), /one line/);
  assert.equal(resolveGmailSender("/Users/vale/.openclaw/workspace-marco").email, "marco@reslu.com.au");
  assert.throws(() => resolveGmailSender("/Users/vale/.openclaw/workspace"), /unavailable/);
});

test("Marco messages are encoded as plain-text MIME with a stable Message-ID", () => {
  const raw = buildGmailRawMessage(
    { name: "Marco Santoro", email: "marco@reslu.com.au" },
    { to: "client@example.com", subject: "West Lakes Shore", body: "Hello", idempotencyKey: "approval-123" },
    "abc@reslu.com.au",
  );
  const decoded = Buffer.from(raw.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  assert.match(decoded, /From: Marco Santoro <marco@reslu\.com\.au>/);
  assert.match(decoded, /To: client@example\.com/);
  assert.match(decoded, /Message-ID: <abc@reslu\.com\.au>/);
  assert.match(decoded, /Content-Type: text\/plain; charset=UTF-8/);
});

test("OAuth loader supports both authorized-user and existing legacy token shapes", () => {
  const authorized = { type: "authorized_user", refresh_token: "refresh", client_id: "id", client_secret: "secret" };
  assert.deepEqual(resolveGoogleAuthInput(authorized, null), { kind: "authorized_user", token: authorized });
  const legacy = { refresh_token: "refresh", access_token: "access" };
  const resolved = resolveGoogleAuthInput(legacy, {
    installed: { client_id: "id", client_secret: "secret", redirect_uris: ["http://localhost"] },
  });
  assert.equal(resolved.kind, "oauth2");
  assert.equal(resolved.clientId, "id");
  assert.equal(resolved.clientSecret, "secret");
  assert.equal(resolved.redirectUri, "http://localhost");
  assert.equal(resolved.token, legacy);
  assert.throws(() => resolveGoogleAuthInput({}, {}), /incomplete/);
});

test("staged PDF paths must stay inside private attachment storage", () => {
  const workspace = "/Users/vale/.openclaw/workspace";
  const staged = `${workspace}/.reslu-conversation-attachments/job-1/client.pdf`;
  assert.equal(resolveStagedAttachmentPath(workspace, staged), staged);
  assert.throws(() => resolveStagedAttachmentPath(workspace, "/private/tmp/client.pdf"), /outside private staging/);
  assert.throws(() => resolveStagedAttachmentPath(workspace, `${workspace}/.reslu-conversation-attachments/job-1/client.txt`), /not a PDF/);
  assert.throws(() => resolveStagedAttachmentPath(workspace, "client.pdf"), /must be absolute/);
});

test("registered adapters expose only the four fixed read-only tools", () => {
  const tools = createReadonlyGoogleTools({ workspaceDir: "/Users/vale/.openclaw/workspace" });
  assert.deepEqual(tools.map((tool) => tool.name), [
    "reslu_calendar_events_list",
    "reslu_gmail_messages_search",
    "reslu_gmail_message_read",
    "reslu_attachment_pdf_text_read",
  ]);
  for (const tool of tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.match(tool.description, /Read-only/);
    assert.equal(typeof tool.execute, "function");
  }
});

test("Marco send adapter is separate, scoped and reports the verified operation", async () => {
  const tool = createMarcoGmailSendTool(
    { workspaceDir: "/Users/vale/.openclaw/workspace-marco" },
    { sendMessage: async (workspace, params) => ({ status: "verified_in_sent", workspace, to: params.to, message_id: "m1" }) },
  );
  assert.equal(tool.name, "reslu_gmail_messages_send");
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ["to", "subject", "body", "idempotency_key"]);
  const result = await tool.execute("call-1", {
    to: "client@example.com",
    subject: "Subject",
    body: "Body",
    idempotency_key: "approval-123",
  });
  assert.equal(result.details.status, "verified_in_sent");
  assert.equal(result.details.workspace, "/Users/vale/.openclaw/workspace-marco");
});
