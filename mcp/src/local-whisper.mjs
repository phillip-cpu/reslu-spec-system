import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAX_LOCAL_MEETING_AUDIO_BYTES = 250 * 1024 * 1024;
export const MAX_LOCAL_TRANSCRIPT_CHARS = 500_000;
const MAX_TRANSCRIBER_OUTPUT_BYTES = 1_000_000;
const TRANSCRIPTION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const moduleDir = dirname(fileURLToPath(import.meta.url));

export function validatePrivateMeetingAudioUrl(value, supabaseUrl) {
  let audioUrl;
  let projectUrl;
  try {
    audioUrl = new URL(value);
    projectUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("Meeting source returned an invalid private audio URL");
  }
  if (audioUrl.protocol !== "https:" || audioUrl.username || audioUrl.password) {
    throw new Error("Meeting audio must use a credential-free HTTPS URL");
  }
  if (audioUrl.origin !== projectUrl.origin) {
    throw new Error("Meeting audio URL is outside the configured Supabase project");
  }
  if (!audioUrl.pathname.startsWith("/storage/v1/object/sign/")) {
    throw new Error("Meeting audio URL is not a signed Supabase Storage object");
  }
  return audioUrl;
}

async function downloadBoundedAudio(audioUrl, destination, fetchImpl = fetch) {
  const response = await fetchImpl(audioUrl, {
    method: "GET",
    redirect: "error",
    headers: { Accept: "audio/mp4,audio/webm,application/octet-stream" },
  });
  if (!response.ok || !response.body) {
    throw new Error(`Private meeting audio download failed (${response.status})`);
  }
  const contentLength = response.headers.get("content-length");
  const statedBytes = contentLength === null ? null : Number(contentLength);
  if (statedBytes !== null && Number.isFinite(statedBytes) && (statedBytes <= 0 || statedBytes > MAX_LOCAL_MEETING_AUDIO_BYTES)) {
    throw new Error("Private meeting audio exceeds the 250 MB local transcription limit");
  }
  let receivedBytes = 0;
  const limiter = new Transform({
    transform(chunk, _encoding, callback) {
      receivedBytes += chunk.length;
      if (receivedBytes > MAX_LOCAL_MEETING_AUDIO_BYTES) {
        callback(new Error("Private meeting audio exceeds the 250 MB local transcription limit"));
        return;
      }
      callback(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(response.body), limiter, createWriteStream(destination, { flags: "wx", mode: 0o600 }));
  if (receivedBytes <= 0) throw new Error("Private meeting audio download was empty");
  return receivedBytes;
}

function collectProcessOutput(child) {
  return new Promise((resolve, reject) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const append = (current, chunk) => {
      if (current.length + chunk.length > MAX_TRANSCRIBER_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("Local Whisper produced an unexpectedly large response"));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const detail = stderr.toString("utf8").trim().split("\n").slice(-2).join(" ").slice(0, 500);
        reject(new Error(`Local Whisper failed${signal ? ` (${signal})` : ""}${detail ? `: ${detail}` : ""}`));
        return;
      }
      resolve(stdout.toString("utf8"));
    });
  });
}

export async function runLocalWhisper(audioPath, options = {}) {
  const pythonPath = options.pythonPath
    ?? process.env.RESLU_LOCAL_WHISPER_PYTHON
    ?? join(moduleDir, "..", ".venv-whisper", "bin", "python3");
  const scriptPath = join(moduleDir, "local-whisper.py");
  await access(pythonPath).catch(() => {
    throw new Error("Local Whisper is not installed. Run bash mcp/install-local-whisper.sh on the RESLU Mac.");
  });
  const child = spawn(pythonPath, [scriptPath, audioPath], {
    cwd: moduleDir,
    env: {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      HF_HOME: process.env.RESLU_LOCAL_WHISPER_CACHE ?? join(moduleDir, "..", ".whisper-cache"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const timeout = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS);
  try {
    const raw = await collectProcessOutput(child);
    const result = JSON.parse(raw);
    const text = typeof result.text === "string" ? result.text.trim().slice(0, MAX_LOCAL_TRANSCRIPT_CHARS) : "";
    if (!text) throw new Error("Local Whisper returned no usable transcript");
    return { ...result, text };
  } finally {
    clearTimeout(timeout);
  }
}

export async function transcribePrivateMeetingSource(source, options = {}) {
  const meeting = source?.meeting;
  if (!meeting || typeof meeting !== "object" || typeof meeting.audio_url !== "string") {
    throw new Error("Meeting source did not include private audio");
  }
  const supabaseUrl = options.supabaseUrl ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("NEXT_PUBLIC_SUPABASE_URL is required for private audio validation");
  const audioUrl = validatePrivateMeetingAudioUrl(meeting.audio_url, supabaseUrl);
  const workingDirectory = await mkdtemp(join(tmpdir(), "reslu-meeting-whisper-"));
  const extension = basename(String(meeting.filename ?? "recording.m4a")).toLowerCase().endsWith(".webm") ? "webm" : "m4a";
  const audioPath = join(workingDirectory, `recording.${extension}`);
  try {
    const byteSize = await (options.downloadAudio ?? downloadBoundedAudio)(audioUrl, audioPath, options.fetchImpl);
    const transcript = await (options.transcribeAudio ?? runLocalWhisper)(audioPath, options);
    const { audio_url: _privateUrl, ...safeMeeting } = meeting;
    return {
      meeting: {
        ...safeMeeting,
        transcript: transcript.text,
        transcription: {
          engine: transcript.engine ?? "mlx-whisper",
          model: transcript.model ?? process.env.RESLU_LOCAL_WHISPER_MODEL ?? "mlx-community/whisper-small-mlx",
          language: transcript.language ?? "en",
          audio_bytes: byteSize,
          privacy: "transcribed locally on the RESLU Mac; audio URL withheld from the model",
        },
      },
    };
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}
