#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { transcribePrivateMeetingSource } from "./local-whisper.mjs";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requiredEnvironment(name, env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function responseJson(response, label) {
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = typeof body?.error === "string" ? body.error : body?.error?.message;
    throw new Error(`${label} failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return body;
}

async function ariaAccessToken(fetchImpl, env) {
  const supabaseUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL", env).replace(/\/$/, "");
  const anonKey = requiredEnvironment("NEXT_PUBLIC_SUPABASE_ANON_KEY", env);
  const email = (env.RESLU_AGENT_EMAIL || env.ARIA_EMAIL || "").trim();
  const password = (env.RESLU_AGENT_PASSWORD || env.ARIA_PASSWORD || "").trim();
  if (!email || !password) throw new Error("Aria credentials are required");
  const response = await fetchImpl(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: anonKey, "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const body = await responseJson(response, "Aria sign-in");
  if (typeof body?.access_token !== "string" || !body.access_token) throw new Error("Aria sign-in returned no access token");
  return body.access_token;
}

async function specRequest(fetchImpl, env, token, path, options = {}) {
  const specUrl = requiredEnvironment("SPEC_URL", env).replace(/\/$/, "");
  const response = await fetchImpl(`${specUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  return responseJson(response, `RESLU ${options.method || "GET"} ${path}`);
}

export async function processMeetingMinutes(meetingId, options = {}) {
  if (!UUID_PATTERN.test(meetingId)) throw new Error("A valid meeting_minutes_id is required");
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const token = await ariaAccessToken(fetchImpl, env);
  const path = `/api/meeting-minutes/${encodeURIComponent(meetingId)}/draft`;
  let source;
  try {
    source = await specRequest(fetchImpl, env, token, path);
    const transcribed = await (options.transcribeSource || transcribePrivateMeetingSource)(source, { supabaseUrl: env.NEXT_PUBLIC_SUPABASE_URL });
    const transcript = transcribed?.meeting?.transcript;
    if (typeof transcript !== "string" || !transcript.trim()) throw new Error("Local Whisper returned no meeting transcript");
    await specRequest(fetchImpl, env, token, path, {
      method: "PATCH",
      body: JSON.stringify({ meeting_minutes_id: meetingId, status: "structure", transcript }),
    });
    return {
      status: "completed",
      summary: "Meeting draft prepared for review.",
      message: "The meeting draft is ready for review.",
    };
  } catch (error) {
    if (source) {
      await specRequest(fetchImpl, env, token, path, {
        method: "PATCH",
        body: JSON.stringify({
          meeting_minutes_id: meetingId,
          status: "failed",
          failure_note: String(error?.message || error).slice(0, 4_000),
        }),
      }).catch(() => undefined);
    }
    throw error;
  }
}

async function main() {
  const flagIndex = process.argv.indexOf("--meeting-id");
  const meetingId = flagIndex >= 0 ? process.argv[flagIndex + 1] : "";
  const result = await processMeetingMinutes(meetingId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    process.stderr.write(`${String(error?.message || error).slice(0, 4_000)}\n`);
    process.exitCode = 1;
  });
}
