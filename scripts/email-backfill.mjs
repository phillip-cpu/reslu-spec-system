#!/usr/bin/env node
// ============================================================
// RESLU Spec System — 6-month email backfill (one-shot)
// Runs the same pipeline as email-ingest.mjs but paginates
// through ALL Gmail results for the past N days.
// Usage:
//   DAYS=180 node scripts/email-backfill.mjs
// ============================================================

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";

const execFileAsync = promisify(execFile);

const WORKSPACE   = "/Users/vale/.openclaw/workspace";
const DAYS        = parseInt(process.env.DAYS || "180");
const GMAIL_Q     = `newer_than:${DAYS}d -from:notifications@monday.com -from:noreply`;
const BATCH_SIZE  = 100; // Gmail API max per page
const ACCOUNTS    = [
  { label: "phillip", tokenPath: `${WORKSPACE}/phillip-gmail/token.json` },
  { label: "aria",    tokenPath: `${WORKSPACE}/aria-gmail/token.json` },
];

const SUPABASE_URL      = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ARIA_EMAIL        = process.env.ARIA_EMAIL;
const ARIA_PASSWORD     = process.env.ARIA_PASSWORD;

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let _accessToken = null;
async function getAccessToken() {
  if (_accessToken) return _accessToken;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: ARIA_EMAIL, password: ARIA_PASSWORD,
  });
  if (error) throw new Error("Supabase auth failed: " + error.message);
  _accessToken = data.session.access_token;
  return _accessToken;
}

function log(...args) { console.log(new Date().toISOString(), ...args); }

// ── Gmail OAuth ───────────────────────────────────────────────
async function loadGmailToken(tokenPath) {
  const raw = JSON.parse(await readFile(tokenPath, "utf8"));
  const credsRaw = JSON.parse(await readFile(`${WORKSPACE}/gmail/credentials.json`, "utf8"));
  const creds = credsRaw.installed || credsRaw.web;
  // Refresh if within 5 min of expiry
  const expiresAt = raw.expiry_date || 0;
  if (Date.now() < expiresAt - 5 * 60 * 1000) return raw.access_token;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: raw.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error("Token refresh failed: " + JSON.stringify(data));
  return data.access_token;
}

async function gmailGet(account, path, token) {
  const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Gmail ${path} → ${res.status}`);
  return res.json();
}

// ── List ALL messages (paginated) ─────────────────────────────
async function listAllMessages(account, token) {
  const all = [];
  let pageToken = null;
  do {
    const url = `/messages?maxResults=${BATCH_SIZE}&q=${encodeURIComponent(GMAIL_Q)}` +
      (pageToken ? `&pageToken=${pageToken}` : "");
    const data = await gmailGet(account, url, token);
    if (data.messages) all.push(...data.messages);
    pageToken = data.nextPageToken || null;
    log(`[${account.label}] fetched page — running total: ${all.length}`);
  } while (pageToken);
  return all;
}

// ── Strip quoted replies (simple version) ─────────────────────
function stripQuotes(text) {
  if (!text) return text;
  const lines = text.split("\n");
  const out = [];
  for (const line of lines) {
    if (/^>/.test(line)) continue;
    if (/^On .+ wrote:$/.test(line.trim())) break;
    if (/^_{5,}/.test(line)) break;
    out.push(line);
  }
  return out.join("\n").trim();
}

// ── Extract text body from Gmail payload ──────────────────────
function extractBody(payload) {
  function decode(b64) {
    return Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  }
  function walk(part) {
    if (!part) return { text: null, html: null };
    if (part.mimeType === "text/plain" && part.body?.data) return { text: decode(part.body.data), html: null };
    if (part.mimeType === "text/html"  && part.body?.data) return { text: null, html: decode(part.body.data) };
    if (part.parts) {
      let text = null, html = null;
      for (const p of part.parts) {
        const r = walk(p);
        if (r.text) text = r.text;
        if (r.html) html = r.html;
      }
      return { text, html };
    }
    return { text: null, html: null };
  }
  return walk(payload);
}

// ── Skip rules ────────────────────────────────────────────────
const SKIP_FROM = [
  "noreply", "no-reply", "notifications@", "monday.com",
  "mailer-daemon", "postmaster", "donotreply",
  "newsletter", "unsubscribe", "marketing@",
];
function shouldSkip(fromAddr, subject) {
  const from = (fromAddr || "").toLowerCase();
  const subj = (subject || "").toLowerCase();
  if (SKIP_FROM.some(s => from.includes(s))) return true;
  if (subj.includes("unsubscribe") || subj.includes("newsletter")) return true;
  return false;
}

// ── Main ──────────────────────────────────────────────────────
async function run() {
  log(`Starting backfill: DAYS=${DAYS}, query="${GMAIL_Q}"`);

  let inserted = 0, skipped = 0, existing = 0, errors = 0;

  for (const account of ACCOUNTS) {
    log(`\n── Account: ${account.label} ──`);
    let token;
    try { token = await loadGmailToken(account.tokenPath); }
    catch (e) { log(`[${account.label}] Token error: ${e.message}`); continue; }

    let messages;
    try { messages = await listAllMessages(account, token); }
    catch (e) { log(`[${account.label}] List error: ${e.message}`); continue; }
    log(`[${account.label}] Total messages to process: ${messages.length}`);

    for (let i = 0; i < messages.length; i++) {
      const { id: gmailId } = messages[i];
      try {
        const msg = await gmailGet(account, `/messages/${gmailId}?format=full`, token);
        const headers = {};
        for (const h of (msg.payload?.headers || [])) headers[h.name.toLowerCase()] = h.value;

        const messageId = headers["message-id"] || `gmail:${account.label}:${gmailId}`;
        const fromAddr  = headers["from"] || "";
        const subject   = headers["subject"] || "";
        const dateStr   = headers["date"] || "";
        const receivedAt = dateStr ? new Date(dateStr) : new Date(parseInt(msg.internalDate || Date.now()));

        if (shouldSkip(fromAddr, subject)) {
          // Upsert as skipped
          await supabase.from("emails").upsert({
            message_id: messageId,
            thread_id: msg.threadId,
            from_addr: fromAddr,
            subject,
            received_at: receivedAt.toISOString(),
            raw_ref: `gmail:${account.label}:${msg.threadId}`,
            status: "skipped",
            processed_at: new Date().toISOString(),
          }, { onConflict: "message_id", ignoreDuplicates: true });
          skipped++;
          continue;
        }

        const { text, html } = extractBody(msg.payload);
        let cleanText = text || "";
        if (!cleanText && html) {
          cleanText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
        cleanText = stripQuotes(cleanText);
        const tokenEstimate = Math.ceil(cleanText.length / 4);

        const dbToken = await getAccessToken();
        // Check if already exists
        const { data: existing_row } = await supabase
          .from("emails")
          .select("id, status")
          .eq("message_id", messageId)
          .maybeSingle();

        if (existing_row) { existing++; continue; }

        const { error } = await supabase.from("emails").insert({
          message_id: messageId,
          thread_id: msg.threadId,
          from_addr: fromAddr,
          subject,
          received_at: receivedAt.toISOString(),
          raw_ref: `gmail:${account.label}:${msg.threadId}`,
          clean_text: cleanText.slice(0, 50000),
          token_estimate: tokenEstimate,
          status: "new",
          processed_at: new Date().toISOString(),
        });

        if (error) {
          if (error.code === "23505") { existing++; } // duplicate
          else { log(`[${account.label}] Insert error ${messageId}: ${error.message}`); errors++; }
        } else {
          inserted++;
          if (inserted % 50 === 0) log(`[${account.label}] Progress: ${inserted} inserted, ${existing} existing, ${skipped} skipped`);
        }
      } catch (e) {
        log(`[${account.label}] Error on ${gmailId}: ${e.message}`);
        errors++;
      }
      // Small delay to avoid Gmail rate limits
      if (i % 20 === 0 && i > 0) await new Promise(r => setTimeout(r, 500));
    }
  }

  log(`\n✓ Backfill complete`);
  log(`  Inserted: ${inserted}`);
  log(`  Already existed: ${existing}`);
  log(`  Skipped (noise): ${skipped}`);
  log(`  Errors: ${errors}`);
}

run().catch(e => { console.error("Fatal:", e); process.exit(1); });
