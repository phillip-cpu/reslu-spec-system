#!/usr/bin/env node
// process-aria-queue.mjs
// Processes approval_needed items from the RESLU spec system aria_queue

import { createClient } from "@supabase/supabase-js";

const SPEC_URL = process.env.SPEC_URL;
const ARIA_EMAIL = process.env.ARIA_EMAIL;
const ARIA_PASSWORD = process.env.ARIA_PASSWORD;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

for (const [name, value] of Object.entries({
  SPEC_URL,
  ARIA_EMAIL,
  ARIA_PASSWORD,
  NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: SUPABASE_ANON_KEY,
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

// Known project IDs
const PROJECTS = {
  Goldsworthy: "00000000-0000-0000-0000-000000000001",
  "100 Childers Street": "00000000-0000-0000-0000-000000000001",
  "North Adelaide": "00000000-0000-0000-0000-000000000001",
  Alley: "fb0e8a97-bb07-4a3c-be1c-99daff8d5437",
  "Glenelg North": "fb0e8a97-bb07-4a3c-be1c-99daff8d5437",
  Conessa: "d9b20309-8f78-487c-8f0e-f96388e49d97",
  "Radio Athens": "0c9cdf57-5579-4ee2-b19d-9fd227a4542d",
  Gerardis: "bcfa3327-5099-4bbc-8f37-6fbe2e468ddf",
  Hone: "c879800a-431f-4170-a793-c6bc5173ddc7",
  "Reslu Studio": "83523056-b0de-4d10-afa7-bd9d5e9351d0",
};

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let cachedToken = null;

async function getToken() {
  if (cachedToken) return cachedToken;
  const { data, error } = await supabase.auth.signInWithPassword({
    email: ARIA_EMAIL,
    password: ARIA_PASSWORD,
  });
  if (error || !data.session) throw new Error(`Auth failed: ${error?.message}`);
  cachedToken = data.session.access_token;
  return cachedToken;
}

async function apiFetch(path, options = {}) {
  const token = await getToken();
  const res = await fetch(`${SPEC_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
      Authorization: `Bearer ${token}`,
    },
  });
  let body = null;
  try { body = await res.json(); } catch {}
  if (!res.ok) {
    const msg = body?.error ?? `HTTP ${res.status}`;
    throw new Error(`${options.method ?? "GET"} ${path}: ${msg}`);
  }
  return body;
}

function matchProject(sourceText) {
  if (!sourceText) return null;
  const lower = sourceText.toLowerCase();
  for (const [key, id] of Object.entries(PROJECTS)) {
    if (lower.includes(key.toLowerCase())) return id;
  }
  return null;
}

const stats = {
  confirmed: 0,
  failed: 0,
  ambiguous: 0,
  trade_reminders: [],
  errors: [],
};

async function processItem(item) {
  const { id, kind, payload } = item;
  console.log(`\n[${kind}] id=${id}`);
  console.log("  payload:", JSON.stringify(payload).slice(0, 300));

  try {
    // trade_reminder — flag, don't resolve
    if (kind === "trade_reminder") {
      stats.trade_reminders.push({ id, payload });
      console.log("  → SKIP (trade_reminder, flagged for report)");
      return;
    }

    // email_proposal with ZZTEST
    if (kind === "email_proposal") {
      const isTest =
        JSON.stringify(payload).toUpperCase().includes("ZZTEST");
      if (isTest) {
        await apiFetch(`/api/aria-queue/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ status: "failed", note: "test entry" }),
        });
        stats.failed++;
        console.log("  → FAILED (test entry)");
        return;
      }
      // Non-test email_proposal — resolve done (these are just notifications)
      await apiFetch(`/api/aria-queue/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status: "done", note: "email_proposal reviewed" }),
      });
      stats.confirmed++;
      console.log("  → DONE (email_proposal, non-test)");
      return;
    }

    // lead_flag
    if (kind === "lead_flag") {
      await apiFetch(`/api/aria-queue/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({ status: "done", note: "reviewed" }),
      });
      stats.confirmed++;
      console.log("  → DONE (lead_flag)");
      return;
    }

    // approval_needed
    if (kind === "approval_needed") {
      const reason = payload?.reason;
      const matchId = payload?.match_id;
      const entityType = payload?.entity_type;
      const sourceText = payload?.source_text;
      const proposalId = payload?.proposal_id;

      // failed_verification — no match_id, has proposal_id
      if (reason === "failed_verification" && !matchId) {
        await apiFetch(`/api/aria-queue/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({
            status: "failed",
            note: "failed verification — auto-rejected by pipeline",
          }),
        });
        stats.failed++;
        console.log("  → FAILED (failed_verification)");
        return;
      }

      if (matchId && entityType === "project") {
        const projectId = matchProject(sourceText);
        if (!projectId) {
          // Ambiguous
          await apiFetch(`/api/aria-queue/${id}/resolve`, {
            method: "POST",
            body: JSON.stringify({
              status: "done",
              note: "ambiguous match — needs manual review",
            }),
          });
          stats.ambiguous++;
          console.log(`  → AMBIGUOUS (project, source="${sourceText}")`);
          return;
        }
        // Correct the match
        await apiFetch(`/api/second-brain/matches/${matchId}/correct`, {
          method: "POST",
          body: JSON.stringify({ entity_id: projectId }),
        });
        await apiFetch(`/api/aria-queue/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ status: "done", note: `matched to project ${projectId}` }),
        });
        stats.confirmed++;
        console.log(`  → DONE (project match: ${projectId} for "${sourceText}")`);
        return;
      }

      if (matchId && entityType === "item") {
        // Search for the item
        let searchResult = null;
        try {
          searchResult = await apiFetch("/api/second-brain/search", {
            method: "POST",
            body: JSON.stringify({ query: sourceText, entity_type: "item", limit: 1 }),
          });
        } catch (e) {
          console.log(`  Search error: ${e.message}`);
        }

        const topResult = searchResult?.results?.[0];
        if (!topResult || topResult.score < 0.5) {
          await apiFetch(`/api/aria-queue/${id}/resolve`, {
            method: "POST",
            body: JSON.stringify({
              status: "done",
              note: "ambiguous match — needs manual review",
            }),
          });
          stats.ambiguous++;
          console.log(`  → AMBIGUOUS (item, source="${sourceText}", no confident match)`);
          return;
        }

        const itemId = topResult.entity_id;
        await apiFetch(`/api/second-brain/matches/${matchId}/correct`, {
          method: "POST",
          body: JSON.stringify({ entity_id: itemId }),
        });
        await apiFetch(`/api/aria-queue/${id}/resolve`, {
          method: "POST",
          body: JSON.stringify({ status: "done", note: `matched to item ${itemId}: ${topResult.title}` }),
        });
        stats.confirmed++;
        console.log(`  → DONE (item match: ${itemId} "${topResult.title}" score=${topResult.score})`);
        return;
      }

      // Fallthrough — unknown approval_needed format
      await apiFetch(`/api/aria-queue/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify({
          status: "done",
          note: "ambiguous match — needs manual review",
        }),
      });
      stats.ambiguous++;
      console.log(`  → AMBIGUOUS (unrecognised approval_needed structure)`);
      return;
    }

    // Unknown kind — resolve done
    await apiFetch(`/api/aria-queue/${id}/resolve`, {
      method: "POST",
      body: JSON.stringify({ status: "done", note: `unknown kind: ${kind}` }),
    });
    stats.confirmed++;
    console.log(`  → DONE (unknown kind: ${kind})`);

  } catch (e) {
    stats.errors.push({ id, kind, error: e.message });
    console.error(`  → ERROR: ${e.message}`);
  }
}

async function main() {
  console.log("=== RESLU Aria Queue Processor ===");
  console.log(`Target: ${SPEC_URL}`);

  let totalProcessed = 0;
  let batchNum = 0;

  while (true) {
    batchNum++;
    console.log(`\n--- Batch ${batchNum} ---`);

    let items;
    try {
      const result = await apiFetch("/api/aria-queue/claim", {
        method: "POST",
        body: JSON.stringify({ limit: 10 }),
      });
      items = result.items ?? [];
    } catch (e) {
      console.error(`Failed to claim batch: ${e.message}`);
      break;
    }

    if (items.length === 0) {
      console.log("Queue empty — done!");
      break;
    }

    console.log(`Claimed ${items.length} items`);

    for (const item of items) {
      await processItem(item);
      totalProcessed++;
    }

    // Small delay between batches to be respectful
    await new Promise(r => setTimeout(r, 500));
  }

  console.log("\n=== FINAL REPORT ===");
  console.log(`Total processed: ${totalProcessed}`);
  console.log(`Confirmed/done: ${stats.confirmed}`);
  console.log(`Failed (verification/test): ${stats.failed}`);
  console.log(`Ambiguous (manual review needed): ${stats.ambiguous}`);
  console.log(`Trade reminders found: ${stats.trade_reminders.length}`);
  if (stats.trade_reminders.length > 0) {
    console.log("Trade reminder details:");
    stats.trade_reminders.forEach(tr => console.log("  -", JSON.stringify(tr)));
  }
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log("  -", JSON.stringify(e)));
  }

  // Write summary file
  const summary = {
    processed: totalProcessed,
    confirmed: stats.confirmed,
    failed: stats.failed,
    ambiguous: stats.ambiguous,
    trade_reminders: stats.trade_reminders,
    errors: stats.errors,
    timestamp: new Date().toISOString(),
  };
  const fs = await import("fs");
  fs.writeFileSync(
    "/Users/vale/.openclaw/workspace/scripts/aria-queue-result.json",
    JSON.stringify(summary, null, 2)
  );
  console.log("\nResult written to aria-queue-result.json");
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
