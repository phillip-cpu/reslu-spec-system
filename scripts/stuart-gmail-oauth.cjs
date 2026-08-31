#!/usr/bin/env node

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const command = process.argv[2];
const workspaceRoot = process.argv[3];
const callbackUrl = process.argv[4];

if (!workspaceRoot || !["start", "finish"].includes(command)) {
  console.error("Usage: node scripts/stuart-gmail-oauth.cjs <start|finish> <openclaw-workspace> [callback-url]");
  process.exit(2);
}

const gmailRoot = path.join(workspaceRoot, "gmail");
const accountsRoot = path.join(workspaceRoot, "accounts-gmail");
const credentialsPath = path.join(gmailRoot, "credentials.json");
const pendingPath = path.join(accountsRoot, "oauth-pending.json");
const tokenPath = path.join(accountsRoot, "token.json");
const { google } = require(path.join(gmailRoot, "node_modules", "googleapis"));

const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
const installed = credentials.installed;
if (!installed?.client_id || !installed?.client_secret || !installed.redirect_uris?.[0]) {
  throw new Error("Installed-app Gmail OAuth credentials are incomplete");
}

const oauth = new google.auth.OAuth2(installed.client_id, installed.client_secret, installed.redirect_uris[0]);
const base64url = (value) => Buffer.from(value).toString("base64url");

async function start() {
  fs.mkdirSync(accountsRoot, { recursive: true, mode: 0o700 });
  const state = base64url(crypto.randomBytes(32));
  const verifier = base64url(crypto.randomBytes(64));
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

  fs.writeFileSync(pendingPath, JSON.stringify({ state, verifier }), { mode: 0o600 });
  fs.chmodSync(pendingPath, 0o600);

  const authUrl = oauth.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: false,
    scope: ["https://www.googleapis.com/auth/gmail.readonly"],
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  process.stdout.write(`${authUrl}\n`);
}

async function finish() {
  if (!callbackUrl) throw new Error("Paste the complete localhost callback URL as the final argument");
  const callback = new URL(callbackUrl);
  const pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
  if (callback.searchParams.get("state") !== pending.state) throw new Error("OAuth state did not match");
  const code = callback.searchParams.get("code");
  if (!code) throw new Error(callback.searchParams.get("error") || "Callback did not contain an authorization code");

  const { tokens } = await oauth.getToken({ code, codeVerifier: pending.verifier });
  const grantedScopes = new Set(String(tokens.scope || "").split(/\s+/).filter(Boolean));
  const readonly = "https://www.googleapis.com/auth/gmail.readonly";
  if (!grantedScopes.has(readonly)) throw new Error("Google did not grant Gmail read-only access");
  const excessive = [...grantedScopes].filter((scope) => scope !== readonly);
  if (excessive.length) throw new Error(`Google returned unexpected scopes: ${excessive.join(", ")}`);
  if (!tokens.refresh_token) throw new Error("Google did not return a refresh token");

  fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  fs.chmodSync(tokenPath, 0o600);
  fs.unlinkSync(pendingPath);
  process.stdout.write("Gmail read-only token saved for accounts@reslu.com.au\n");
}

Promise.resolve(command === "start" ? start() : finish()).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
