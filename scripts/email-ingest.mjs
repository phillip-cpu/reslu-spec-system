#!/usr/bin/env node
// ============================================================
// RESLU Spec System — email ingest pipeline (Step 8)
// BUILD-SPEC.md §"Email ingest + preprocessing":
//   Runs every 10 min on Aria's Mac mini via launchd (see plist at
//   the bottom of this file). Fetches new mail from Gmail (Phillip +
//   Aria), strips reply history + signatures, extracts PDF text, and
//   writes rows into the `emails` + `email_attachments` tables for
//   the downstream triage + project-matching steps.
//
// Design notes (mirrors backup-offsite.mjs / import-monday-leads.mjs):
//   - Zero new npm dependencies: @supabase/supabase-js from app
//     node_modules, Node built-ins only.
//   - Auth: same pattern as mcp/src/index.mjs — sign in as Aria via
//     signInWithPassword to get a JWT, then use that for all DB writes
//     (no service-role key required; Aria is admin-role in Supabase).
//   - Gmail: REST API via fetch() — no googleapis library needed.
//     OAuth2 tokens loaded from the workspace token files; access
//     token refreshed automatically when within 5 min of expiry.
//   - PDFs: pdftotext (poppler, already installed). ocrmypdf falls
//     back gracefully to needs_vision=true if not on PATH.
//   - pdftotext uses form-feed (\f) as page separator — pages are
//     split on that character for the >5-page keep-filter.
//
// Env required:
//   NEXT_PUBLIC_SUPABASE_URL  — same as app's .env.local
//   NEXT_PUBLIC_SUPABASE_ANON_KEY — same as app's .env.local
//   ARIA_EMAIL, ARIA_PASSWORD — Aria's Supabase user credentials
//
// Run (dry-run to verify without writing):
//   DRY_RUN=1 node scripts/email-ingest.mjs
// Run live:
//   NEXT_PUBLIC_SUPABASE_URL=https://... NEXT_PUBLIC_SUPABASE_ANON_KEY=... \
//   ARIA_EMAIL=aria@reslu.com.au ARIA_PASSWORD=... \
//   node scripts/email-ingest.mjs
//
// launchD plist: ~/Library/LaunchAgents/ai.reslu.email-ingest.plist
// (example at the bottom of this file)
// ============================================================

import { createClient } from "@supabase/supabase-js";
import {
  readFile, writeFile, mkdir, rm, stat,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";

const execFileAsync = promisify(execFile);

// ── Config ────────────────────────────────────────────────────
const DRY_RUN = process.env.DRY_RUN === "1";
const WORKSPACE = "/Users/vale/.openclaw/workspace";
const CREDENTIALS_PATH = `${WORKSPACE}/gmail/credentials.json`;
const ACCOUNTS = [
  { label: "phillip", tokenPath: `${WORKSPACE}/phillip-gmail/token.json` },
  { label: "aria",    tokenPath: `${WORKSPACE}/aria-gmail/token.json` },
  { label: "tenille", tokenPath: `${WORKSPACE}/tenille-gmail/token.json` },
];
const FETCH_PER_ACCOUNT = 50; // messages to check per run per account
const GMAIL_Q = "newer_than:2d"; // look-back window; deduplication handles the rest
const TMP_DIR = join(tmpdir(), "reslu-email-ingest");

const SUPABASE_URL  = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ARIA_EMAIL    = process.env.ARIA_EMAIL;
const ARIA_PASSWORD = process.env.ARIA_PASSWORD;

for (const [name, value] of Object.entries({
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON,
  ARIA_EMAIL,
  ARIA_PASSWORD,
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

// ── Skip rules ────────────────────────────────────────────────
// Newsletters, auto-replies, noreply senders → status='skipped'
const SKIP_FROM_RE = /noreply|no[-_]reply|do[-_]?not[-_]?reply|donotreply|notifications?@|updates?@|bounce@|mailer-daemon|postmaster@|automated@|system@|info@monday\.com|quickbooks@notification/i;
const SKIP_SUBJECT_RE = /^(re:\s*)?(auto(matic)?\s*(reply|response)|out\s+of\s+office|ooo\s*:|delivery\s*(status\s*)?notification|undeliverable|mail\s*delivery\s*(failed|returned)|automated\s+response)/i;
const SKIP_LIST_UNSUB_RE = /list-unsubscribe/i; // header name

// ── PDF page-keep pattern ─────────────────────────────────────
// Keep pages that contain prices, timeframes, or trade keywords.
// Applied only when a PDF has > 5 pages (brief spec).
const KEEP_PAGE_RE = /\$[\d,]+\.?\d*|(?:\d+(?:\.\d+)?)\s*(?:wk|week|weeks)\b|\b(?:tile|tiling|joinery|joiner|plumb(?:ing|er)|electrical|electrician|paint(?:ing|er)|plaster(?:ing|er)|render(?:ing)?|stone|benchtop|window|glazing|carpet|flooring|demolish(?:ion)?|waterproof(?:ing)?|scaffold(?:ing)?|carpent(?:ry|er)|framing|insulation|concreting|roofing|landscap(?:e|ing)|hvac|aircon|ducting|quote|quotation|invoice|supply\s+and\s+install|inc\.?\s*gst|ex\.?\s*gst|total|subtotal|labour|labor|materials)\b/i;

// ── Helpers ───────────────────────────────────────────────────

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Decode base64url-encoded Gmail payload data */
function decodeB64(str) {
  // Gmail uses base64url (- and _ instead of + and /)
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
}

/** Minimal HTML → plain text: strip tags, decode entities, normalise whitespace. */
function htmlToText(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|tr|h[1-6]|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Strip quoted reply history and email signatures from plain text.
 * Cuts at the FIRST occurrence of any recognised reply/sig marker.
 * The brief cites talon/email_reply_parser; we implement equivalent
 * heuristics inline to stay dependency-free.
 */
function stripRepliesAndSig(text) {
  // These patterns mark the start of a reply thread or signature block.
  const MARKERS = [
    // Reply headers (Gmail, Outlook, Apple Mail, various locales)
    /^On .{5,200}wrote:\s*$/m,           // Apple Mail / iOS: "On <date>, <name> wrote:"
    /^-{3,}\s*Original Message\s*-{3,}$/im,
    /^From:\s*.+\r?\nSent:\s*.+\r?\nTo:\s*/im,
    /^From:\s*.+\r?\nDate:\s*.+\r?\nSubject:\s*/im,
    /^>[ >]/m,                           // Apple Mail / iOS single-'>' quote prefix
    /^>{2,}/m,                           // Outlook/plain-text double-quote
    /^\[cid:/m,                          // Outlook embedded image references
    // Signature separators
    /^--\s*$/m,                          // RFC 3676 sig delimiter
    /^_{3,}$/m,                          // Outlook horizontal rule
    /^\*{3,}$/m,
  ];

  // Common sign-off phrases on their own line — always cut here.
  // Low false-positive risk: these phrases at the start of a line
  // almost never appear mid-body in a business email.
  const SIGNOFF_RE = /^(?:kind\s+regards|with\s+kind\s+regards|regards|best\s+regards|cheers|thanks|thank\s+you|sincerely|yours\s+(?:sincerely|faithfully)|warm(?:est)?\s+regards|many\s+thanks|yours\s+truly|all\s+the\s+best)[,.]?\s*$/im;

  let cutPos = text.length;

  for (const re of MARKERS) {
    const m = text.match(re);
    if (m && typeof m.index === "number" && m.index < cutPos) {
      cutPos = m.index;
    }
  }

  // Sign-off: cut unconditionally — any sign-off phrase on its own line
  // is almost certainly the start of the signature block, regardless of
  // position. (The earlier 0.6 guard was too conservative and missed
  // short replies where the sign-off was in the first half of the text.)
  const soMatch = text.match(SIGNOFF_RE);
  if (soMatch && typeof soMatch.index === "number" && soMatch.index < cutPos) {
    cutPos = soMatch.index;
  }

  return text.substring(0, cutPos).trim();
}

/** Rough token estimate: 1 token ≈ 4 chars for English prose. */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// ── OAuth2 / Gmail REST API ───────────────────────────────────

let credsCache = null;
async function loadCreds() {
  if (credsCache) return credsCache;
  const raw = JSON.parse(await readFile(CREDENTIALS_PATH, "utf-8"));
  const c = raw.installed || raw.web;
  credsCache = { client_id: c.client_id, client_secret: c.client_secret };
  return credsCache;
}

/**
 * Return a valid access token for the given account, refreshing if needed.
 * Writes the refreshed token back to the token file.
 */
async function getAccessToken(account) {
  const token = JSON.parse(await readFile(account.tokenPath, "utf-8"));
  const creds = await loadCreds();

  // Refresh if expiry within 5 minutes or missing
  const expiryMs = token.expiry_date ?? 0;
  if (Date.now() < expiryMs - 5 * 60 * 1000 && token.access_token) {
    return token.access_token;
  }

  log(`[${account.label}] Refreshing access token…`);
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id:     creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: token.refresh_token,
      grant_type:    "refresh_token",
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Token refresh failed for ${account.label}: ${err}`);
  }
  const refreshed = await resp.json();
  const updated = {
    ...token,
    access_token: refreshed.access_token,
    expiry_date:  Date.now() + refreshed.expires_in * 1000,
  };
  if (!DRY_RUN) {
    await writeFile(account.tokenPath, JSON.stringify(updated, null, 2));
  }
  return refreshed.access_token;
}

/** Thin Gmail REST API wrapper. */
async function gmailGet(account, path, token) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gmail GET ${path} [${account.label}]: HTTP ${resp.status} ${err.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * List message IDs matching GMAIL_Q for this account.
 * Returns an array of { id, threadId } objects (maxResults cap applies).
 */
async function listMessages(account, token) {
  const data = await gmailGet(
    account,
    `/messages?maxResults=${FETCH_PER_ACCOUNT}&q=${encodeURIComponent(GMAIL_Q)}`,
    token,
  );
  return data.messages || [];
}

/**
 * Fetch a full message and return a structured object:
 * { messageId, threadId, fromAddr, subject, receivedAt, headers,
 *   textBody, htmlBody, attachments: [{filename, mime, attachmentId}] }
 */
async function fetchMessage(account, gmailId, token) {
  const msg = await gmailGet(account, `/messages/${gmailId}?format=full`, token);

  const headerMap = {};
  for (const h of (msg.payload?.headers || [])) {
    headerMap[h.name.toLowerCase()] = h.value;
  }

  const messageId = headerMap["message-id"] || `gmail:${account.label}:${gmailId}`;
  const threadId  = msg.threadId;
  const fromAddr  = headerMap["from"] || "";
  const subject   = headerMap["subject"] || "";
  const dateStr   = headerMap["date"] || "";
  const receivedAt = dateStr ? new Date(dateStr) : new Date(msg.internalDate ? parseInt(msg.internalDate) : Date.now());
  const hasListUnsub = SKIP_LIST_UNSUB_RE.test(Object.keys(headerMap).join(" "));

  // Walk MIME tree
  let textBody = "";
  let htmlBody = "";
  const attachments = [];

  function walkParts(parts) {
    if (!parts) return;
    for (const part of parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        textBody = decodeB64(part.body.data);
      } else if (part.mimeType === "text/html" && part.body?.data) {
        htmlBody = decodeB64(part.body.data);
      } else if (part.filename && part.body?.attachmentId) {
        attachments.push({
          filename:     part.filename,
          mime:         part.mimeType,
          attachmentId: part.body.attachmentId,
        });
      }
      if (part.parts) walkParts(part.parts);
    }
  }

  // Handle simple (non-multipart) payloads
  if (msg.payload?.body?.data) {
    const mt = msg.payload.mimeType || "text/plain";
    if (mt === "text/html") {
      htmlBody = decodeB64(msg.payload.body.data);
    } else {
      textBody = decodeB64(msg.payload.body.data);
    }
  }
  walkParts(msg.payload?.parts);

  return {
    gmailId, messageId, threadId, fromAddr, subject, receivedAt,
    hasListUnsub, textBody, htmlBody, attachments,
    rawRef: `gmail:${account.label}:${gmailId}`,
  };
}

/** Download an attachment's bytes. */
async function fetchAttachment(account, gmailId, attachmentId, token) {
  const data = await gmailGet(
    account,
    `/messages/${gmailId}/attachments/${attachmentId}`,
    token,
  );
  return Buffer.from(
    (data.data || "").replace(/-/g, "+").replace(/_/g, "/"),
    "base64",
  );
}

// ── PDF extraction ────────────────────────────────────────────

/**
 * Extract text from a PDF file path using pdftotext.
 * Returns { text, pageTexts, pageCount } where pageTexts is an array
 * of per-page strings (split on form-feed \f).
 */
async function pdfToText(pdfPath) {
  try {
    const { stdout } = await execFileAsync("pdftotext", ["-layout", pdfPath, "-"], {
      maxBuffer: 20 * 1024 * 1024, // 20 MB
    });
    const pageTexts = stdout.split("\f").map((p) => p.trim()).filter(Boolean);
    return { text: stdout.trim(), pageTexts, pageCount: pageTexts.length };
  } catch (err) {
    // pdftotext may exit non-zero on scanned PDFs — treat as empty
    return { text: "", pageTexts: [], pageCount: 0 };
  }
}

/**
 * Attempt OCR via ocrmypdf (if installed), writing a new PDF to
 * tmpPath_ocr.pdf and then re-running pdftotext on it.
 * Returns { text, pageTexts, pageCount } or null if ocrmypdf not found.
 */
async function pdfOcr(pdfPath) {
  const ocrPath = pdfPath.replace(/\.pdf$/i, "_ocr.pdf");
  try {
    await execFileAsync("ocrmypdf", ["--force-ocr", "--quiet", pdfPath, ocrPath], {
      maxBuffer: 50 * 1024 * 1024,
    });
    const result = await pdfToText(ocrPath);
    // Clean up OCR'd copy
    await rm(ocrPath, { force: true });
    return result;
  } catch (err) {
    if (err.code === "ENOENT") return null; // not installed
    return { text: "", pageTexts: [], pageCount: 0 };
  }
}

/**
 * Get page count from pdftotext output (reliable) or via pdfinfo.
 * Used when extraction fails entirely (needs_vision path).
 */
async function pdfPageCount(pdfPath) {
  try {
    const { stdout } = await execFileAsync("pdfinfo", [pdfPath]);
    const m = stdout.match(/Pages:\s*(\d+)/);
    return m ? parseInt(m[1]) : null;
  } catch {
    // pdfinfo not available — count form-feeds from pdftotext
    const { stdout } = await execFileAsync("pdftotext", [pdfPath, "-"], {
      maxBuffer: 1024 * 1024,
    }).catch(() => ({ stdout: "" }));
    return stdout.split("\f").filter(Boolean).length || null;
  }
}

/**
 * Given extracted pageTexts for a PDF with > 5 pages, return the
 * 1-indexed page numbers whose content matches KEEP_PAGE_RE.
 */
function filterPages(pageTexts) {
  const kept = [];
  for (let i = 0; i < pageTexts.length; i++) {
    if (KEEP_PAGE_RE.test(pageTexts[i])) {
      kept.push(i + 1); // 1-indexed
    }
  }
  return kept;
}

/**
 * Full PDF pipeline for one attachment file.
 * Returns { extractedText, extractionMethod, needsVision, pageCount, keptPages }.
 */
async function processPdf(pdfPath) {
  // Step 1: pdftotext
  let { text, pageTexts, pageCount } = await pdfToText(pdfPath);

  if (text) {
    const keptPages = pageCount > 5 ? filterPages(pageTexts) : null;
    return {
      extractedText:    pageCount > 5 && keptPages.length > 0
        ? keptPages.map((n) => pageTexts[n - 1]).join("\n\n---\n\n")
        : text,
      extractionMethod: "pdftotext",
      needsVision:      false,
      pageCount,
      keptPages:        pageCount > 5 ? keptPages : null,
    };
  }

  // Step 2: ocrmypdf
  const ocr = await pdfOcr(pdfPath);
  if (ocr && ocr.text) {
    const keptPages = ocr.pageCount > 5 ? filterPages(ocr.pageTexts) : null;
    return {
      extractedText:    ocr.pageCount > 5 && keptPages.length > 0
        ? keptPages.map((n) => ocr.pageTexts[n - 1]).join("\n\n---\n\n")
        : ocr.text,
      extractionMethod: "ocrmypdf",
      needsVision:      false,
      pageCount:        ocr.pageCount,
      keptPages:        ocr.pageCount > 5 ? keptPages : null,
    };
  }

  // Step 3: needs_vision — store page count, no text
  const pc = await pdfPageCount(pdfPath).catch(() => null);
  return {
    extractedText:    null,
    extractionMethod: null,
    needsVision:      true,
    pageCount:        pc,
    keptPages:        null,
  };
}

// ── Supabase auth ─────────────────────────────────────────────

let sbClient = null;
async function getSupabase() {
  if (sbClient) return sbClient;
  if (!SUPABASE_URL || !SUPABASE_ANON) {
    throw new Error("NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required.");
  }
  const client = createClient(SUPABASE_URL, SUPABASE_ANON);
  const { error } = await client.auth.signInWithPassword({
    email: ARIA_EMAIL,
    password: ARIA_PASSWORD,
  });
  if (error) throw new Error(`Supabase sign-in failed: ${error.message}`);
  sbClient = client;
  return client;
}

/**
 * Return a Set of message_ids already in the emails table,
 * given a list of candidate IDs. Avoids re-processing.
 */
async function fetchExistingIds(sb, messageIds) {
  if (!messageIds.length || !sb) return new Set();
  const { data, error } = await sb
    .from("emails")
    .select("message_id")
    .in("message_id", messageIds);
  if (error) throw new Error(`DB check failed: ${error.message}`);
  return new Set((data || []).map((r) => r.message_id));
}

// ── Main ──────────────────────────────────────────────────────

async function processAccount(account, sb) {
  log(`[${account.label}] Starting fetch (${GMAIL_Q})`);
  const token = await getAccessToken(account);
  const messages = await listMessages(account, token);
  log(`[${account.label}] ${messages.length} message(s) in window`);
  if (!messages.length) return { inserted: 0, skipped: 0, errors: 0 };

  // Batch-fetch message IDs to check which already exist
  // We need the RFC Message-ID header, so we have to fetch each message.
  // To avoid N+1 on the DB check: collect all message IDs first, then query once.
  const metaList = [];
  for (const { id: gmailId } of messages) {
    try {
      const meta = await fetchMessage(account, gmailId, token);
      metaList.push(meta);
    } catch (err) {
      log(`[${account.label}] WARN: fetch ${gmailId}: ${err.message}`);
    }
  }

  const candidateIds = metaList.map((m) => m.messageId);
  const existing = await fetchExistingIds(sb, candidateIds);
  log(`[${account.label}] ${existing.size} already in DB, ${candidateIds.length - existing.size} new`);

  let inserted = 0, skipped = 0, errors = 0;

  for (const meta of metaList) {
    if (existing.has(meta.messageId)) continue;

    const { messageId, threadId, fromAddr, subject, receivedAt,
            hasListUnsub, textBody, htmlBody, attachments, rawRef } = meta;

    // ── Skip rules ──────────────────────────────────────────
    const fromNorm = fromAddr.toLowerCase();
    const shouldSkip =
      SKIP_FROM_RE.test(fromNorm) ||
      SKIP_SUBJECT_RE.test(subject) ||
      hasListUnsub;

    if (shouldSkip) {
      log(`[${account.label}] SKIP: ${subject.slice(0, 60)}`);
      if (!DRY_RUN) {
        await sb.from("emails").insert({
          message_id:    messageId,
          thread_id:     threadId,
          from_addr:     fromAddr,
          subject,
          received_at:   receivedAt.toISOString(),
          raw_ref:       rawRef,
          clean_text:    null,
          token_estimate: null,
          status:        "skipped",
          processed_at:  new Date().toISOString(),
        });
      }
      skipped++;
      continue;
    }

    // ── Build clean_text ──────────────────────────────────────
    // Prefer plain text; fall back to HTML → text conversion
    const rawText = textBody || (htmlBody ? htmlToText(htmlBody) : "");
    const cleanText = stripRepliesAndSig(rawText);
    const tokenEstimate = estimateTokens(cleanText);

    log(`[${account.label}] NEW: "${subject.slice(0, 60)}" | ${tokenEstimate} tokens | ${attachments.length} attachment(s)`);

    if (DRY_RUN) {
      console.log("  clean_text snippet:", cleanText.slice(0, 120).replace(/\n/g, " "));
      inserted++;
      continue;
    }

    // ── Insert email row ─────────────────────────────────────
    const { data: emailRow, error: emailErr } = await sb
      .from("emails")
      .insert({
        message_id:    messageId,
        thread_id:     threadId,
        from_addr:     fromAddr,
        subject,
        received_at:   receivedAt.toISOString(),
        raw_ref:       rawRef,
        clean_text:    cleanText,
        token_estimate: tokenEstimate,
        status:        "new",
        processed_at:  new Date().toISOString(),
      })
      .select("id")
      .single();

    if (emailErr) {
      log(`[${account.label}] ERROR inserting ${messageId}: ${emailErr.message}`);
      errors++;
      continue;
    }

    const emailId = emailRow.id;

    // ── Process PDF attachments ──────────────────────────────
    const pdfAttachments = attachments.filter(
      (a) => a.mime === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf"),
    );

    for (const att of pdfAttachments) {
      try {
        // Download to temp
        await mkdir(TMP_DIR, { recursive: true });
        const safeName = att.filename.replace(/[^a-z0-9._-]/gi, "_");
        const tmpPath  = join(TMP_DIR, `${emailId}_${safeName}`);

        const bytes = await fetchAttachment(account, meta.gmailId, att.attachmentId, token);
        await writeFile(tmpPath, bytes);

        // Extract
        const {
          extractedText, extractionMethod, needsVision, pageCount, keptPages,
        } = await processPdf(tmpPath);

        // Cleanup temp
        await rm(tmpPath, { force: true });

        // Insert attachment row
        const { error: attErr } = await sb.from("email_attachments").insert({
          email_id:         emailId,
          filename:         att.filename,
          mime:             att.mime,
          storage_ref:      null, // Upload to Supabase Storage is a later step
          extracted_text:   extractedText,
          extraction_method: extractionMethod,
          needs_vision:     needsVision,
          page_count:       pageCount,
          kept_pages:       keptPages,
        });

        if (attErr) {
          log(`[${account.label}] WARN attachment insert: ${attErr.message}`);
        } else {
          log(`  PDF "${att.filename}": ${extractionMethod ?? "needs_vision"}, ${pageCount ?? "?"} pages${keptPages ? `, kept [${keptPages.join(",")}]` : ""}`);
        }
      } catch (attErr) {
        log(`[${account.label}] WARN processing attachment "${att.filename}": ${attErr.message}`);
      }
    }

    inserted++;
  }

  return { inserted, skipped, errors };
}

async function main() {
  log("=== email-ingest start" + (DRY_RUN ? " (DRY RUN)" : "") + " ===");
  await mkdir(TMP_DIR, { recursive: true });

  const sb = DRY_RUN ? null : await getSupabase();

  let totalInserted = 0, totalSkipped = 0, totalErrors = 0;

  for (const account of ACCOUNTS) {
    try {
      const { inserted, skipped, errors } = await processAccount(account, sb);
      totalInserted += inserted;
      totalSkipped  += skipped;
      totalErrors   += errors;
    } catch (err) {
      log(`[${account.label}] FATAL: ${err.message}`);
      totalErrors++;
    }
  }

  log(`=== email-ingest done: ${totalInserted} inserted, ${totalSkipped} skipped, ${totalErrors} errors ===`);
  if (totalErrors > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// ============================================================
// launchd plist — save to ~/Library/LaunchAgents/ai.reslu.email-ingest.plist
// then: launchctl load ~/Library/LaunchAgents/ai.reslu.email-ingest.plist
//
// <?xml version="1.0" encoding="UTF-8"?>
// <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
//   "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
// <plist version="1.0">
// <dict>
//   <key>Label</key>
//   <string>ai.reslu.email-ingest</string>
//   <key>ProgramArguments</key>
//   <array>
//     <string>/opt/homebrew/bin/node</string>
//     <string>/Users/vale/reslu-spec-system/scripts/email-ingest.mjs</string>
//   </array>
//   <key>EnvironmentVariables</key>
//   <dict>
//     <key>NEXT_PUBLIC_SUPABASE_URL</key>    <string>https://tnwtpljckhdyyrqjaneo.supabase.co</string>
//     <key>NEXT_PUBLIC_SUPABASE_ANON_KEY</key> <string><!-- anon key --></string>
//     <key>ARIA_EMAIL</key>                  <string>aria@reslu.com.au</string>
//     <key>ARIA_PASSWORD</key>               <string><!-- password --></string>
//   </dict>
//   <key>StartInterval</key>
//   <integer>600</integer>
//   <key>RunAtLoad</key>
//   <true/>
//   <key>StandardOutPath</key>
//   <string>/Users/vale/reslu-spec-system/logs/email-ingest.log</string>
//   <key>StandardErrorPath</key>
//   <string>/Users/vale/reslu-spec-system/logs/email-ingest-err.log</string>
// </dict>
// </plist>
// ============================================================
