import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServerClient } from "@supabase/ssr";
import { createClient } from "@supabase/supabase-js";

assert.equal(
  process.env.RESLU_RUN_PRODUCTION_MEETING_ACCEPTANCE,
  "true",
  "Set RESLU_RUN_PRODUCTION_MEETING_ACCEPTANCE=true to run this production drill",
);

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert(url && anonKey && serviceKey, "Required Supabase environment is missing");

const appUrl = process.env.RESLU_ACCEPTANCE_APP_URL || "https://spec.reslu.com.au";
const runId = randomUUID();
const email = `meeting-mode-${runId}@example.invalid`;
const password = `Meeting-${randomUUID()}-9!`;
const destinationLabel = `Acceptance ${runId.slice(0, 8)}`;
const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const temporaryDirectory = await mkdtemp(join(tmpdir(), "reslu-meeting-acceptance-"));

let userId;
let conversationId;
let leadId;
let meetingId;
let recordingPath;
let cookie = "";

const request = async (path, init = {}) => {
  const response = await fetch(`${appUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", cookie, ...(init.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
};

const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8" });
  assert.equal(result.status, 0, `${command} failed: ${result.stderr || result.stdout}`);
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
    full_name: "Meeting Mode acceptance",
    email,
    role: "viewer",
  });
  assert.ifError(profileError);

  const { data: lead, error: leadError } = await admin.from("leads").insert({
    surname_project: destinationLabel,
    first_name: "Synthetic",
    stage: "Potential Lead",
    site_visit_date: new Date().toISOString(),
    created_by: userId,
  }).select("id").single();
  assert.ifError(leadError);
  leadId = lead.id;

  const client = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password });
  assert.ifError(signInError);
  assert(signedIn.session);

  const { data: conversation, error: conversationError } = await client.rpc(
    "create_conversation_idempotent",
    {
      p_title: destinationLabel,
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

  const context = await request(`/api/conversations/${conversationId}/meeting-mode/context`);
  assert.equal(context.response.status, 200, JSON.stringify(context.body));
  const destination = context.body.candidates?.find((candidate) => candidate.kind === "lead" && candidate.id === leadId);
  assert(destination, "Synthetic lead was not offered as a Meeting Mode destination");

  const started = await request(`/api/conversations/${conversationId}/meeting-mode`, {
    method: "POST",
    body: JSON.stringify({
      consent_confirmed: true,
      client_session_id: randomUUID(),
      destination_kind: "lead",
      destination_id: leadId,
      client_event_id: null,
      meeting_type: "new_lead",
    }),
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  meetingId = started.body.meeting?.id;
  assert(meetingId);
  assert.equal(started.body.meeting.status, "recording");

  const aiffPath = join(temporaryDirectory, "meeting.aiff");
  const audioPath = join(temporaryDirectory, "meeting.m4a");
  run("/usr/bin/say", [
    "-v", "Samantha",
    "-o", aiffPath,
    "This is a synthetic RESLU meeting mode acceptance. The decision is to prepare a concept proposal. The client requested a follow up next Tuesday. RESLU will draft the proposal. The open question is the construction budget.",
  ]);
  run("/opt/homebrew/bin/ffmpeg", ["-loglevel", "error", "-y", "-i", aiffPath, "-c:a", "aac", "-b:a", "64k", audioPath]);
  const audio = await readFile(audioPath);
  assert(audio.byteLength > 0);

  const upload = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ filename: "meeting.m4a", byte_size: audio.byteLength }),
  });
  assert.equal(upload.response.status, 200, JSON.stringify(upload.body));
  recordingPath = upload.body.path;
  assert(recordingPath && upload.body.token);

  const { error: uploadError } = await client.storage
    .from("assets")
    .uploadToSignedUrl(recordingPath, upload.body.token, audio, { contentType: "audio/mp4" });
  assert.ifError(uploadError);

  const finished = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "finish",
      recording_storage_path: recordingPath,
      recording_filename: "meeting.m4a",
      recording_mime_type: "audio/mp4",
      recording_byte_size: audio.byteLength,
      duration_seconds: 18,
    }),
  });
  assert.equal(finished.response.status, 200, JSON.stringify(finished.body));
  assert.equal(finished.body.meeting.status, "processing");
  assert(finished.body.task_id);

  let review;
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const status = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`);
    assert.equal(status.response.status, 200, JSON.stringify(status.body));
    if (status.body.meeting?.status === "review" || status.body.meeting?.status === "failed") {
      review = status.body.meeting;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert(review, "Meeting draft did not finish inside six minutes");
  assert.equal(review.status, "review", JSON.stringify(review));
  assert.equal(review.destination_kind, "lead");
  assert.equal(review.lead_id, leadId);
  assert.equal(typeof review.transcript, "string");
  assert(review.transcript.trim().length > 0);
  assert.equal(typeof review.summary, "string");
  assert(review.summary.trim().length > 0);

  const { data: prematureRecords, error: prematureError } = await admin
    .from("conversation_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("kind", "meeting_record");
  assert.ifError(prematureError);
  assert.equal(prematureRecords.length, 0, "Meeting filed before human approval");

  const saved = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "save_draft",
      expected_version: review.draft_version,
      destination_kind: "lead",
      destination_id: leadId,
      client_event_id: null,
      meeting_type: review.meeting_type,
      summary: `${review.summary}\n\nReviewed by the production acceptance drill.`,
      decisions: review.decisions,
      client_requests: review.client_requests,
      reslu_actions: review.reslu_actions,
      client_actions: review.client_actions,
      open_questions: review.open_questions,
      important_notes: review.important_notes,
    }),
  });
  assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.meeting.draft_version, review.draft_version + 1);

  const filed = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "file", expected_version: saved.body.meeting.draft_version }),
  });
  assert.equal(filed.response.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.meeting.status, "filed");
  assert.equal(filed.body.meeting.lead_id, leadId);
  assert(filed.body.meeting.filed_message_id);

  const { data: record, error: recordError } = await admin
    .from("conversation_messages")
    .select("id,kind,metadata")
    .eq("id", filed.body.meeting.filed_message_id)
    .single();
  assert.ifError(recordError);
  assert.equal(record.kind, "meeting_record");
  assert.equal(record.metadata?.meeting_minutes_id, meetingId);
  assert.equal(record.metadata?.destination_kind, "lead");
  assert.equal(record.metadata?.destination_id, leadId);

  console.log(JSON.stringify({
    result: "PASS — Meeting Mode captured, drafted, held for review and filed to the exact lead",
    meeting_id: meetingId,
    destination_kind: filed.body.meeting.destination_kind,
    draft_version: filed.body.meeting.draft_version,
    linked_timeline_records: 1,
  }));
} finally {
  if (recordingPath) await admin.storage.from("assets").remove([recordingPath]);
  if (conversationId) {
    const { error } = await admin.from("conversations").delete().eq("id", conversationId);
    assert.ifError(error);
  }
  if (leadId) {
    const { error } = await admin.from("leads").delete().eq("id", leadId);
    assert.ifError(error);
  }
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    assert.ifError(error);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
