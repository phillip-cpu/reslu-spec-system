import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

assert.equal(
  process.env.RESLU_RUN_PRODUCTION_VOICE_COLLAB_ACCEPTANCE,
  "true",
  "Set RESLU_RUN_PRODUCTION_VOICE_COLLAB_ACCEPTANCE=true to run this production drill",
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && anonKey && serviceKey, "Required Supabase environment is missing");
const appUrl = "https://spec.reslu.com.au";
const runId = randomUUID();
const email = `voice-collaboration-${runId}@example.invalid`;
const password = `Collaboration-${randomUUID()}-9!`;
const toolCallId = `voice-collaboration-${runId}`;
const fixedQuery = "Classify this as marketing or operations without taking action: a website lead form is receiving submissions but Google Ads reports zero attributed conversions. Give one concise commercial diagnostic.";
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
let userId;
let conversationId;
let callId;
let cookie = "";

const request = async (path, init = {}) => {
  const response = await fetch(`${appUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

try {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(createError);
  userId = created.user?.id;
  assert(userId);
  const { error: profileError } = await admin.from("profiles").insert({
    id: userId,
    full_name: "Voice collaboration acceptance",
    email,
    role: "viewer",
  });
  assert.ifError(profileError);

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert(signedIn.session);
  const { data: conversation, error: conversationError } = await client.rpc(
    "create_conversation_idempotent",
    {
      p_title: null,
      p_profile_ids: [],
      p_agent_slugs: ["aria"],
      p_client_conversation_id: randomUUID(),
    },
  ).single();
  assert.ifError(conversationError);
  conversationId = conversation?.conversation_id;
  assert(conversationId);

  const cookieJar = new Map();
  const serverClient = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const item of cookies) cookieJar.set(item.name, item.value);
      },
    },
  });
  const { error: sessionError } = await serverClient.auth.setSession(signedIn.session);
  assert.ifError(sessionError);
  cookie = [...cookieJar].map(([name, value]) => `${name}=${value}`).join("; ");
  assert(cookie);

  const started = await request(`/api/conversations/${conversationId}/calls`, {
    method: "POST",
    body: JSON.stringify({ presentation: "office", client_call_id: randomUUID() }),
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  callId = started.body.call?.id;
  assert(callId);

  const consultPayload = {
    query: fixedQuery,
    owner_agent_slug: "aria",
    target_agent_slug: "marco",
    call_id: callId,
    tool_call_id: toolCallId,
    response_id: null,
  };
  const queued = await request(`/api/conversations/${conversationId}/realtime/specialist`, {
    method: "POST",
    body: JSON.stringify(consultPayload),
  });
  assert([200, 202].includes(queued.response.status), JSON.stringify(queued.body));
  assert.equal(queued.body.owner_agent, "aria");
  assert.equal(queued.body.consulted_agent, "marco");

  const repeated = await request(`/api/conversations/${conversationId}/realtime/specialist`, {
    method: "POST",
    body: JSON.stringify(consultPayload),
  });
  assert([200, 202].includes(repeated.response.status), JSON.stringify(repeated.body));
  assert.equal(repeated.body.consultation_id, queued.body.consultation_id);
  assert.equal(repeated.body.job_id, queued.body.job_id);

  let terminal;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    const status = await request(`/api/conversations/${conversationId}/realtime/specialist?tool_call_id=${encodeURIComponent(toolCallId)}&owner_agent_slug=aria`);
    assert.equal(status.response.status, 200, JSON.stringify(status.body));
    if (status.body.status === "done" || status.body.status === "failed" || status.body.status === "cancelled") {
      terminal = status.body;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(terminal, "Specialist consultation did not finish inside three minutes");
  assert.equal(terminal.status, "done", JSON.stringify(terminal));
  assert.equal(terminal.owner_agent, "aria");
  assert.equal(terminal.consulted_agent, "marco");
  assert.equal(typeof terminal.answer, "string");
  assert(terminal.answer.trim().length > 0);

  const [{ data: consultations, error: consultationError }, { data: messages, error: messageError }] = await Promise.all([
    admin.from("conversation_agent_consultations")
      .select("id,status,response_message_id")
      .eq("conversation_id", conversationId)
      .eq("realtime_tool_call_id", toolCallId),
    admin.from("conversation_messages")
      .select("id,author_agent_id,metadata")
      .eq("conversation_id", conversationId)
      .eq("metadata->>consulted_agent_slug", "marco"),
  ]);
  assert.ifError(consultationError);
  assert.ifError(messageError);
  assert.equal(consultations.length, 1);
  assert.equal(consultations[0].status, "done");
  assert.equal(messages.length, 2, "Expected one request plus one owner-visible answer");
  const answer = messages.find((message) => message.metadata?.source === "agent_consultation");
  assert(answer);
  assert.equal(answer.metadata.owner_agent_slug, "aria");
  assert.equal(answer.metadata.consulted_agent_slug, "marco");
  assert.equal(answer.id, consultations[0].response_message_id);

  const ended = await request(`/api/conversations/${conversationId}/calls`, {
    method: "PATCH",
    body: JSON.stringify({ call_id: callId, summary: "Isolated specialist acceptance completed." }),
  });
  assert.equal(ended.response.status, 200, JSON.stringify(ended.body));

  console.log(JSON.stringify({
    result: "PASS — Aria consulted Marco exactly once through the live voice backend",
    owner: terminal.owner_agent,
    specialist: terminal.consulted_agent,
    consultation_rows: consultations.length,
    attributed_messages: messages.length,
    latency: terminal.latency,
  }));
} finally {
  if (conversationId) {
    const { error } = await admin.from("conversations").delete().eq("id", conversationId);
    assert.ifError(error);
  }
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    assert.ifError(error);
  }
}
