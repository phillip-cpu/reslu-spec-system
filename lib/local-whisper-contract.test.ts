import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  transcribePrivateMeetingSource,
  validatePrivateMeetingAudioUrl,
} from "../mcp/src/local-whisper.mjs";

const projectUrl = "https://tnwtpljckhdyyrqjaneo.supabase.co";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Meeting Mode has a fully pinned, preloadable Mac transcription runtime", () => {
  const installer = readFileSync(resolve(root, "mcp/install-local-whisper.sh"), "utf8");
  const lock = readFileSync(resolve(root, "mcp/requirements-whisper.lock"), "utf8");
  const route = readFileSync(resolve(root, "app/api/conversations/[id]/meeting-mode/[meetingId]/route.ts"), "utf8");
  const mcp = readFileSync(resolve(root, "mcp/src/index.mjs"), "utf8");
  assert.match(lock, /^mlx-whisper==0\.4\.3$/m);
  assert.match(lock, /^mlx==[0-9.]+$/m);
  assert.match(installer, /requirements-whisper\.lock/);
  assert.match(installer, /snapshot_download/);
  assert.match(route, /tool transcribes the private recording locally/i);
  assert.match(mcp, /transcribePrivateMeetingSource\(source\)/);
});

test("Meeting Mode accepts only signed audio from the configured Supabase project", () => {
  const valid = `${projectUrl}/storage/v1/object/sign/attachments/meeting-minutes/a/recording.m4a?token=private`;
  assert.equal(validatePrivateMeetingAudioUrl(valid, projectUrl).origin, projectUrl);
  assert.throws(() => validatePrivateMeetingAudioUrl("http://tnwtpljckhdyyrqjaneo.supabase.co/storage/v1/object/sign/x", projectUrl), /HTTPS/);
  assert.throws(() => validatePrivateMeetingAudioUrl("https://example.com/storage/v1/object/sign/x", projectUrl), /outside/);
  assert.throws(() => validatePrivateMeetingAudioUrl(`${projectUrl}/storage/v1/object/public/x`, projectUrl), /signed/);
});

test("Meeting Mode transcribes locally, withholds the URL and deletes temporary audio", async () => {
  const privateUrl = `${projectUrl}/storage/v1/object/sign/attachments/meeting-minutes/a/recording.m4a?token=private`;
  let temporaryPath = "";
  const result = await transcribePrivateMeetingSource({
    meeting: { id: "meeting-a", filename: "client.m4a", audio_url: privateUrl, destination_label: "Smith Residence" },
  }, {
    supabaseUrl: projectUrl,
    fetchImpl: async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { "content-length": "4" } }),
    transcribeAudio: async (audioPath: string) => {
      temporaryPath = audioPath;
      assert.deepEqual([...await readFile(audioPath)], [1, 2, 3, 4]);
      return { text: "The client selected the limestone finish.", language: "en", engine: "mlx-whisper", model: "test-model" };
    },
  });
  assert.equal(result.meeting.transcript, "The client selected the limestone finish.");
  assert.equal("audio_url" in result.meeting, false);
  assert.equal(result.meeting.transcription.audio_bytes, 4);
  await assert.rejects(access(temporaryPath));
});

test("Meeting Mode deletes temporary audio when local transcription fails", async () => {
  const privateUrl = `${projectUrl}/storage/v1/object/sign/attachments/meeting-minutes/a/recording.webm?token=private`;
  let temporaryPath = "";
  await assert.rejects(transcribePrivateMeetingSource({ meeting: { id: "meeting-a", filename: "client.webm", audio_url: privateUrl } }, {
    supabaseUrl: projectUrl,
    fetchImpl: async () => new Response(new Uint8Array([9]), { status: 200 }),
    transcribeAudio: async (audioPath: string) => {
      temporaryPath = audioPath;
      throw new Error("test transcription failure");
    },
  }), /test transcription failure/);
  await assert.rejects(access(temporaryPath));
});
