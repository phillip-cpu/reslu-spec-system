import assert from "node:assert/strict";
import test from "node:test";
import { processMeetingMinutes } from "./process-meeting-minutes.mjs";

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "Content-Type": "application/json" },
});

test("deterministically fetches, transcribes and stages one matching meeting", async () => {
  const meetingId = "123e4567-e89b-42d3-a456-426614174000";
  const requests = [];
  const result = await processMeetingMinutes(meetingId, {
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SPEC_URL: "https://spec.example.com",
      ARIA_EMAIL: "aria@example.com",
      ARIA_PASSWORD: "password",
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, init });
      if (url.includes("/auth/v1/token")) return jsonResponse({ access_token: "aria-token" });
      if ((init.method || "GET") === "GET") return jsonResponse({ meeting: { audio_url: "private" } });
      return jsonResponse({ meeting: { status: "review" } });
    },
    transcribeSource: async () => ({ meeting: { transcript: "Exact transcript." } }),
  });

  assert.equal(result.status, "completed");
  assert.equal(requests.length, 3);
  const patch = JSON.parse(requests[2].init.body);
  assert.equal(patch.status, "structure");
  assert.equal(patch.transcript, "Exact transcript.");
});

test("rejects an invalid meeting id before network access", async () => {
  await assert.rejects(() => processMeetingMinutes("not-a-meeting", {
    fetchImpl: async () => { throw new Error("network should not run"); },
  }), /valid meeting_minutes_id/);
});
