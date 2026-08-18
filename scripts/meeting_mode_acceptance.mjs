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
let projectId;
let cookie = "";
const recordingPaths = [];

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

const assertNoTimelineRecord = async (meetingId) => {
  const { data, error } = await admin
    .from("conversation_messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("kind", "meeting_record")
    .contains("metadata", { meeting_minutes_id: meetingId });
  assert.ifError(error);
  assert.equal(data.length, 0, `Meeting ${meetingId} filed before explicit approval`);
};

const captureDraft = async ({
  client,
  audio,
  destinationKind,
  destinationId,
  clientEventId,
  meetingType,
}) => {
  const context = await request(`/api/conversations/${conversationId}/meeting-mode/context`);
  assert.equal(context.response.status, 200, JSON.stringify(context.body));
  if (destinationKind) {
    const destination = context.body.candidates?.find((candidate) => (
      candidate.kind === destinationKind
      && candidate.id === destinationId
      && candidate.client_event_id === clientEventId
    ));
    assert(destination, `The exact ${destinationKind} destination was not offered`);
  }

  const started = await request(`/api/conversations/${conversationId}/meeting-mode`, {
    method: "POST",
    body: JSON.stringify({
      consent_confirmed: true,
      client_session_id: randomUUID(),
      destination_kind: destinationKind,
      destination_id: destinationId,
      client_event_id: clientEventId,
      meeting_type: meetingType,
    }),
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.body));
  const meetingId = started.body.meeting?.id;
  assert(meetingId);
  assert.equal(started.body.meeting.status, "recording");

  const upload = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}/upload-url`, {
    method: "POST",
    body: JSON.stringify({ filename: "meeting.m4a", byte_size: audio.byteLength }),
  });
  assert.equal(upload.response.status, 200, JSON.stringify(upload.body));
  assert(upload.body.path && upload.body.token);
  recordingPaths.push(upload.body.path);

  const { error: uploadError } = await client.storage
    .from("assets")
    .uploadToSignedUrl(upload.body.path, upload.body.token, audio, { contentType: "audio/mp4" });
  assert.ifError(uploadError);

  const finished = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "finish",
      recording_storage_path: upload.body.path,
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
  assert(review, `Meeting ${meetingId} did not finish inside six minutes`);
  assert.equal(review.status, "review", JSON.stringify(review));
  assert.equal(review.destination_kind, destinationKind);
  assert.equal(review.lead_id, destinationKind === "lead" ? destinationId : null);
  assert.equal(review.project_id, destinationKind === "project" ? destinationId : null);
  assert.equal(review.client_event_id, clientEventId);
  assert.equal(typeof review.transcript, "string");
  assert(review.transcript.trim().length > 0);
  assert.equal(typeof review.summary, "string");
  assert(review.summary.trim().length > 0);
  await assertNoTimelineRecord(meetingId);
  return { meetingId, review };
};

const saveDraft = async ({ meetingId, review, destinationKind, destinationId, clientEventId }) => {
  const saved = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({
      action: "save_draft",
      expected_version: review.draft_version,
      destination_kind: destinationKind,
      destination_id: destinationId,
      client_event_id: clientEventId,
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
  assert.equal(saved.body.meeting.destination_kind, destinationKind);
  assert.equal(saved.body.meeting.lead_id, destinationKind === "lead" ? destinationId : null);
  assert.equal(saved.body.meeting.project_id, destinationKind === "project" ? destinationId : null);
  assert.equal(saved.body.meeting.client_event_id, clientEventId);
  await assertNoTimelineRecord(meetingId);
  return saved.body.meeting;
};

const fileDraft = async ({ meetingId, expectedVersion, destinationKind, destinationId, clientEventId }) => {
  const filed = await request(`/api/conversations/${conversationId}/meeting-mode/${meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "file", expected_version: expectedVersion }),
  });
  assert.equal(filed.response.status, 200, JSON.stringify(filed.body));
  assert.equal(filed.body.meeting.status, "filed");
  assert.equal(filed.body.meeting.destination_kind, destinationKind);
  assert.equal(filed.body.meeting.lead_id, destinationKind === "lead" ? destinationId : null);
  assert.equal(filed.body.meeting.project_id, destinationKind === "project" ? destinationId : null);
  assert.equal(filed.body.meeting.client_event_id, clientEventId);
  assert(filed.body.meeting.filed_message_id);

  const { data: records, error } = await admin
    .from("conversation_messages")
    .select("id,kind,metadata")
    .eq("conversation_id", conversationId)
    .eq("kind", "meeting_record")
    .contains("metadata", { meeting_minutes_id: meetingId });
  assert.ifError(error);
  assert.equal(records.length, 1, `Meeting ${meetingId} did not create exactly one linked timeline record`);
  assert.equal(records[0].id, filed.body.meeting.filed_message_id);
  assert.equal(records[0].metadata?.destination_kind, destinationKind);
  assert.equal(records[0].metadata?.destination_id, destinationId);
  assert.equal(records[0].metadata?.client_event_id, clientEventId);
  return filed.body.meeting;
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

  const { data: leadRow, error: leadError } = await admin.from("leads").insert({
    surname_project: `${destinationLabel} Lead`,
    first_name: "Synthetic",
    stage: "Potential Lead",
    site_visit_date: new Date().toISOString(),
    created_by: userId,
  }).select("id").single();
  assert.ifError(leadError);
  leadId = leadRow.id;

  const { data: projectRow, error: projectError } = await admin.from("projects").insert({
    name: `${destinationLabel} Project`,
    client_name: "Synthetic Client",
    status: "active",
    created_by: userId,
  }).select("id").single();
  assert.ifError(projectError);
  projectId = projectRow.id;

  const now = Date.now();
  const { data: events, error: eventsError } = await admin.from("client_events").insert([
    {
      project_id: projectId,
      title: "Design review acceptance",
      starts_at: new Date(now - 6 * 60_000).toISOString(),
      ends_at: new Date(now + 60 * 60_000).toISOString(),
      created_by: userId,
    },
    {
      project_id: projectId,
      title: "Selections review acceptance",
      starts_at: new Date(now - 5 * 60_000).toISOString(),
      ends_at: new Date(now + 60 * 60_000).toISOString(),
      created_by: userId,
    },
    {
      project_id: projectId,
      title: "Site review acceptance",
      starts_at: new Date(now - 4 * 60_000).toISOString(),
      ends_at: new Date(now + 60 * 60_000).toISOString(),
      created_by: userId,
    },
  ]).select("id,title");
  assert.ifError(eventsError);
  assert.equal(events.length, 3);
  const eventByTitle = new Map(events.map((event) => [event.title, event]));
  const projectEvent = eventByTitle.get("Design review acceptance");
  const ambiguousEventA = eventByTitle.get("Selections review acceptance");
  const ambiguousEventB = eventByTitle.get("Site review acceptance");
  assert(projectEvent && ambiguousEventA && ambiguousEventB);

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

  const lead = await captureDraft({ client, audio, destinationKind: "lead", destinationId: leadId, clientEventId: null, meetingType: "new_lead" });
  const savedLead = await saveDraft({ ...lead, destinationKind: "lead", destinationId: leadId, clientEventId: null });
  const filedLead = await fileDraft({ meetingId: lead.meetingId, expectedVersion: savedLead.draft_version, destinationKind: "lead", destinationId: leadId, clientEventId: null });

  const project = await captureDraft({ client, audio, destinationKind: "project", destinationId: projectId, clientEventId: projectEvent.id, meetingType: "design_meeting" });
  const savedProject = await saveDraft({ ...project, destinationKind: "project", destinationId: projectId, clientEventId: projectEvent.id });
  const filedProject = await fileDraft({ meetingId: project.meetingId, expectedVersion: savedProject.draft_version, destinationKind: "project", destinationId: projectId, clientEventId: projectEvent.id });

  const ambiguousContext = await request(`/api/conversations/${conversationId}/meeting-mode/context`);
  assert.equal(ambiguousContext.response.status, 200, JSON.stringify(ambiguousContext.body));
  const nearbyEvents = ambiguousContext.body.candidates?.filter((candidate) => (
    candidate.kind === "project"
    && candidate.id === projectId
    && [ambiguousEventA.id, ambiguousEventB.id].includes(candidate.client_event_id)
  ));
  assert.equal(nearbyEvents.length, 2, "Two nearby events for the same project were not kept distinct");
  assert.equal(ambiguousContext.body.needs_clarification, true);
  assert.equal(ambiguousContext.body.suggested, null);

  const ambiguous = await captureDraft({ client, audio, destinationKind: null, destinationId: null, clientEventId: null, meetingType: "client_meeting" });

  const unassignedApproval = await request(`/api/conversations/${conversationId}/meeting-mode/${ambiguous.meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "file", expected_version: ambiguous.review.draft_version }),
  });
  assert.equal(unassignedApproval.response.status, 409, JSON.stringify(unassignedApproval.body));
  assert.match(unassignedApproval.body.error || "", /choose a lead or project/i);
  await assertNoTimelineRecord(ambiguous.meetingId);

  const assigned = await saveDraft({ ...ambiguous, destinationKind: "project", destinationId: projectId, clientEventId: ambiguousEventA.id });
  const corrected = await saveDraft({
    meetingId: ambiguous.meetingId,
    review: assigned,
    destinationKind: "project",
    destinationId: projectId,
    clientEventId: ambiguousEventB.id,
  });
  assert.notEqual(assigned.client_event_id, corrected.client_event_id);

  const staleApproval = await request(`/api/conversations/${conversationId}/meeting-mode/${ambiguous.meetingId}`, {
    method: "PATCH",
    body: JSON.stringify({ action: "file", expected_version: assigned.draft_version }),
  });
  assert.equal(staleApproval.response.status, 409, JSON.stringify(staleApproval.body));
  assert.match(staleApproval.body.error || "", /changed|refresh/i);
  await assertNoTimelineRecord(ambiguous.meetingId);

  const filedAmbiguous = await fileDraft({ meetingId: ambiguous.meetingId, expectedVersion: corrected.draft_version, destinationKind: "project", destinationId: projectId, clientEventId: ambiguousEventB.id });

  const { data: destinationEvents, error: destinationEventsError } = await admin
    .from("conversation_meeting_minute_events")
    .select("event_type")
    .eq("minutes_id", ambiguous.meetingId)
    .eq("event_type", "destination_changed");
  assert.ifError(destinationEventsError);
  assert.equal(destinationEvents.length, 2, "The ambiguous destination assignment and correction were not audited exactly once each");

  console.log(JSON.stringify({
    result: "PASS — Meeting Mode lead, project and ambiguous-destination matrix completed",
    scenarios: {
      lead: { meeting_id: lead.meetingId, destination_kind: filedLead.destination_kind, linked_timeline_records: 1 },
      project: { meeting_id: project.meetingId, destination_kind: filedProject.destination_kind, client_event_id: filedProject.client_event_id, linked_timeline_records: 1 },
      ambiguous: {
        meeting_id: ambiguous.meetingId,
        destination_kind: filedAmbiguous.destination_kind,
        corrected_client_event_id: filedAmbiguous.client_event_id,
        stale_approval_rejected: true,
        unassigned_filing_rejected: true,
        destination_change_events: 2,
        linked_timeline_records: 1,
      },
    },
  }));
} finally {
  if (recordingPaths.length > 0) await admin.storage.from("assets").remove(recordingPaths);
  if (conversationId) {
    const { error } = await admin.from("conversations").delete().eq("id", conversationId);
    assert.ifError(error);
  }
  if (leadId) {
    const { error } = await admin.from("leads").delete().eq("id", leadId);
    assert.ifError(error);
  }
  if (projectId) {
    const { error } = await admin.from("projects").delete().eq("id", projectId);
    assert.ifError(error);
  }
  if (userId) {
    const { error } = await admin.auth.admin.deleteUser(userId);
    assert.ifError(error);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
