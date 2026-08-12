import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const VERSION = 1;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

function storageRoot() {
  return process.env.RESLU_CONVERSATION_ENVELOPE_DIR
    || path.join(os.homedir(), ".openclaw", "run", "reslu-conversation-guard");
}

function secretPath() {
  return path.join(storageRoot(), "hmac.key");
}

function envelopePath(sessionKey) {
  const digest = crypto.createHash("sha256").update(sessionKey).digest("hex");
  return path.join(storageRoot(), `${digest}.json`);
}

function ensureRoot() {
  fs.mkdirSync(storageRoot(), { recursive: true, mode: 0o700 });
  try { fs.chmodSync(storageRoot(), 0o700); } catch {}
}

function loadOrCreateSecret() {
  ensureRoot();
  try {
    return fs.readFileSync(secretPath());
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const secret = crypto.randomBytes(32);
  try {
    fs.writeFileSync(secretPath(), secret, { flag: "wx", mode: 0o600 });
    return secret;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return fs.readFileSync(secretPath());
  }
}

function canonical(payload) {
  return JSON.stringify({
    version: payload.version,
    sessionKey: payload.sessionKey,
    runId: payload.runId,
    mode: payload.mode,
    workspaceDir: payload.workspaceDir,
    issuedAt: payload.issuedAt,
    expiresAt: payload.expiresAt,
  });
}

function sign(payload, secret) {
  return crypto.createHmac("sha256", secret).update(canonical(payload)).digest("hex");
}

function validMode(mode) {
  return ["human_request", "specialist_consultation", "attachment_review", "forwarded_context"].includes(mode);
}

export function persistBridgeEnvelope({ sessionKey, runId, mode, workspaceDir }, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  if (typeof sessionKey !== "string" || !sessionKey || typeof runId !== "string" || !runId) return null;
  if (!validMode(mode) || typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) return null;
  const secret = loadOrCreateSecret();
  const payload = {
    version: VERSION,
    sessionKey,
    runId,
    mode,
    workspaceDir: path.resolve(workspaceDir),
    issuedAt: now,
    expiresAt: now + ttlMs,
  };
  const record = { ...payload, signature: sign(payload, secret) };
  const target = envelopePath(sessionKey);
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
  fs.renameSync(temporary, target);
  try { fs.chmodSync(target, 0o600); } catch {}
  return { mode: payload.mode, workspaceDir: payload.workspaceDir };
}

export function loadBridgeEnvelope(sessionKey, now = Date.now()) {
  if (typeof sessionKey !== "string" || !sessionKey) return null;
  try {
    const record = JSON.parse(fs.readFileSync(envelopePath(sessionKey), "utf8"));
    if (record.version !== VERSION || record.sessionKey !== sessionKey || !validMode(record.mode)) return null;
    if (typeof record.workspaceDir !== "string" || !path.isAbsolute(record.workspaceDir)) return null;
    if (!Number.isFinite(record.issuedAt) || !Number.isFinite(record.expiresAt)) return null;
    if (record.issuedAt > now + 30_000 || record.expiresAt <= now || record.expiresAt - record.issuedAt > DEFAULT_TTL_MS) return null;
    if (typeof record.signature !== "string") return null;
    const expected = sign(record, loadOrCreateSecret());
    const supplied = Buffer.from(record.signature, "hex");
    const wanted = Buffer.from(expected, "hex");
    if (supplied.length !== wanted.length || !crypto.timingSafeEqual(supplied, wanted)) return null;
    return { mode: record.mode, workspaceDir: path.resolve(record.workspaceDir) };
  } catch {
    return null;
  }
}

export function clearBridgeEnvelope(sessionKey, runId) {
  if (typeof sessionKey !== "string" || !sessionKey) return;
  const target = envelopePath(sessionKey);
  try {
    if (runId) {
      const record = JSON.parse(fs.readFileSync(target, "utf8"));
      if (record.runId !== runId) return;
    }
    fs.unlinkSync(target);
  } catch (error) {
    if (error?.code !== "ENOENT") return;
  }
}
