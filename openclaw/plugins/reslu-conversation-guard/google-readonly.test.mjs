import assert from "node:assert/strict";
import test from "node:test";
import {
  createReadonlyGoogleTools,
  normalizeCalendarRequest,
  normalizeGmailMessageId,
  normalizeGmailSearchRequest,
  normalizeMailbox,
  resolveGoogleAuthInput,
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
  assert.throws(() => normalizeGmailSearchRequest({ query: "x".repeat(301) }), /300/);
  assert.throws(() => normalizeMailbox("accounts"), /one of/);
});

test("gmail detail reads accept only opaque provider IDs", () => {
  assert.equal(normalizeGmailMessageId("18f_aBc-123"), "18f_aBc-123");
  assert.throws(() => normalizeGmailMessageId("../../token.json"), /invalid/);
  assert.throws(() => normalizeGmailMessageId("id\nnext"), /invalid/);
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
