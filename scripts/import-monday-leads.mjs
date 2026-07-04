#!/usr/bin/env node
// ============================================================
// RESLU Spec System — one-time Monday.com leads import
// BUILD-SPEC.md "Week 10 — Leads pipeline": "the brief asks for
// real-time bidirectional Monday sync; instead the native leads board
// becomes the source of truth after a one-time import (script
// provided, run on the mini with MONDAY_API_TOKEN using the brief's
// column IDs). Optional push-back deferred."
//
// This is a ONE-TIME migration script, not an ongoing sync — it is
// SAFE TO RE-RUN (upserts on `monday_item_id`, so re-running after
// fixing a mapping issue does not create duplicate leads), but once
// the leads module is in daily use, this script should not be run
// again against live data without checking with Phillip first (a
// stale re-run could overwrite native edits with the Monday snapshot
// at run time — see the upsert note below).
//
// Plain Node, ESM (.mjs) — no TypeScript, no ts-node, no extra
// dependencies beyond what's already used elsewhere in this repo
// (@supabase/supabase-js — already a dependency of the main app, and
// resolvable here because this script lives inside the same
// node_modules tree once `npm install` has been run for the app
// itself on the mini; it does NOT declare its own package.json).
//
// Run: DRY_RUN=1 (default) prints exactly what would be
// imported/skipped without writing anything. Set DRY_RUN=0 to write.
//
//   MONDAY_API_TOKEN=xxx SUPABASE_SERVICE_ROLE_KEY=xxx \
//   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
//   node scripts/import-monday-leads.mjs           # dry run (default)
//
//   DRY_RUN=0 MONDAY_API_TOKEN=xxx SUPABASE_SERVICE_ROLE_KEY=xxx \
//   NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co \
//   node scripts/import-monday-leads.mjs           # writes for real
// ============================================================

import { createClient } from "@supabase/supabase-js";

const MONDAY_ENDPOINT = "https://api.monday.com/v2";
const MONDAY_API_VERSION = "2024-01";
const BOARD_ID = "1808939489";

// Column IDs — exactly as given in BUILD-SPEC.md's leads section
// source brief. Do not "correct"/rename these to look more readable;
// they must match Monday's actual column ids verbatim or every value
// silently maps to nothing.
const COLUMNS = {
  status: "lead_status",
  email: "lead_email",
  phone: "lead_phone",
  firstName: "text_mkx21cq5",
  location: "location",
  receivedAt: "date_mks7dgnk",
  followUp: "date_mkv6mwr4",
  siteVisit: "date_mkwsjbtd",
  constructionValue: "numeric_mkv5tz65",
  designValue: "numeric_mkxd49yk",
  designRange: "timerange_mkwspehq",
  constructionRange: "timerange_mkwshvgr",
};

const DRY_RUN = process.env.DRY_RUN !== "0";

// ------------------------------------------------------------
// Stage mapping
//
// BUILD-SPEC.md: "maps group title -> stage (META and DIRECT groups
// -> 'Potential Lead' with source set accordingly; other groups map
// by name)". Monday's "lead_status" column (a status/label column) is
// NOT the stage in this mapping — group membership is. If a board
// ever has BOTH a meaningful lead_status value and a group title, the
// group title wins (per the explicit instruction), and lead_status's
// text is preserved in `notes` so nothing is silently discarded.
//
// "Other groups map by name" is interpreted as: the group's title is
// matched case-insensitively against the 10 canonical stage names; an
// unrecognised group title is NOT dropped — it's logged clearly and
// the item is skipped (never guessed into a wrong stage), so Phillip
// can extend this map rather than data quietly landing in the wrong
// column.
// ------------------------------------------------------------
const GROUP_STAGE_MAP = {
  "potential lead": "Potential Lead",
  "site visit booked": "Site Visit Booked",
  "awaiting to send proposal": "Awaiting to Send Proposal",
  "proposal sent": "Proposal Sent",
  "design work in progress": "Design Work In Progress",
  "construction in progress": "Construction In Progress",
  "unable to contact": "Unable to Contact",
  "lead lost": "Lead Lost",
  complete: "Complete",
  "potential future lead": "Potential Future Lead",
};

function resolveStageAndSource(groupTitle) {
  const normalised = groupTitle.trim().toLowerCase();

  // META / DIRECT groups both land in 'Potential Lead' with source set
  // accordingly (BUILD-SPEC.md, verbatim).
  if (normalised === "meta") {
    return { stage: "Potential Lead", source: "META" };
  }
  if (normalised === "direct") {
    return { stage: "Potential Lead", source: "DIRECT" };
  }

  const stage = GROUP_STAGE_MAP[normalised];
  if (stage) {
    return { stage, source: null };
  }

  return { stage: null, source: null };
}

// ------------------------------------------------------------
// Monday GraphQL transport — same "query is always a static string,
// all dynamic data travels as `variables`" rule as lib/monday/client.ts
// in the main app (BUILD-SPEC.md §Security: "Monday GraphQL calls use
// variables, never string interpolation"). This script is a separate
// process from the Next app, so it can't import lib/monday/client.ts
// directly (different runtime, no Next module resolution) — the same
// safety rule is reimplemented here rather than relaxed.
// ------------------------------------------------------------
async function mondayGraphql(query, variables) {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) {
    throw new Error("MONDAY_API_TOKEN is not set");
  }

  const res = await fetch(MONDAY_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
      "API-Version": MONDAY_API_VERSION,
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Monday API error: ${json.errors.map((e) => e.message).join("; ")}`);
  }
  if (!res.ok) {
    throw new Error(`Monday API HTTP ${res.status}`);
  }
  return json.data;
}

/**
 * Fetches every item on the board across every group, paginating via
 * items_page's cursor. Returns a flat array of
 * { id, name, group: { title }, column_values: [...] }.
 */
async function fetchAllItems() {
  const items = [];
  let cursor = null;

  const query = `
    query ($boardId: ID!, $cursor: String, $limit: Int!) {
      boards(ids: [$boardId]) {
        items_page(limit: $limit, cursor: $cursor) {
          cursor
          items {
            id
            name
            group { title }
            column_values(ids: [
              "${COLUMNS.status}", "${COLUMNS.email}", "${COLUMNS.phone}",
              "${COLUMNS.firstName}", "${COLUMNS.location}", "${COLUMNS.receivedAt}",
              "${COLUMNS.followUp}", "${COLUMNS.siteVisit}", "${COLUMNS.constructionValue}",
              "${COLUMNS.designValue}", "${COLUMNS.designRange}", "${COLUMNS.constructionRange}"
            ]) {
              id
              text
              value
            }
          }
        }
      }
    }
  `;
  // Note: the column ids array above is interpolated into the query
  // string, but every value in it is a FIXED CONSTANT from the
  // COLUMNS map (never user/board-supplied data) — this is the same
  // "static structure, variables carry the actual data" rule as
  // lib/monday/client.ts; $boardId/$cursor/$limit (the only genuinely
  // dynamic values) all travel as GraphQL variables, never spliced in.

  do {
    const data = await mondayGraphql(query, {
      boardId: BOARD_ID,
      cursor,
      limit: 100,
    });
    const page = data.boards?.[0]?.items_page;
    if (!page) break;
    items.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  return items;
}

function colText(columnValues, columnId) {
  const col = columnValues.find((c) => c.id === columnId);
  return col?.text?.trim() || null;
}

function colDate(columnValues, columnId) {
  const col = columnValues.find((c) => c.id === columnId);
  if (!col?.value) return null;
  try {
    const parsed = JSON.parse(col.value);
    return parsed?.date || null; // "YYYY-MM-DD"
  } catch {
    return null;
  }
}

function colNumeric(columnValues, columnId) {
  const text = colText(columnValues, columnId);
  if (!text) return null;
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** timerange columns store { from, to } as ISO date strings inside `value`. */
function colTimeRange(columnValues, columnId) {
  const col = columnValues.find((c) => c.id === columnId);
  if (!col?.value) return { from: null, to: null };
  try {
    const parsed = JSON.parse(col.value);
    return { from: parsed?.from || null, to: parsed?.to || null };
  } catch {
    return { from: null, to: null };
  }
}

function mapItemToLead(item) {
  const groupTitle = item.group?.title ?? "";
  const { stage, source } = resolveStageAndSource(groupTitle);
  const cv = item.column_values;

  const statusText = colText(cv, COLUMNS.status);
  const design = colTimeRange(cv, COLUMNS.designRange);
  const construction = colTimeRange(cv, COLUMNS.constructionRange);

  const notesParts = [];
  if (statusText) notesParts.push(`Monday lead_status: ${statusText}`);
  if (!stage) notesParts.push(`Unmapped Monday group: "${groupTitle}"`);

  return {
    monday_item_id: String(item.id),
    surname_project: item.name,
    first_name: colText(cv, COLUMNS.firstName),
    source,
    stage: stage ?? undefined, // undefined -> DB default 'Potential Lead' if unmapped
    email: colText(cv, COLUMNS.email),
    phone: colText(cv, COLUMNS.phone),
    location: colText(cv, COLUMNS.location),
    received_at: colDate(cv, COLUMNS.receivedAt),
    follow_up_date: colDate(cv, COLUMNS.followUp),
    site_visit_date: colDate(cv, COLUMNS.siteVisit),
    construction_value: colNumeric(cv, COLUMNS.constructionValue),
    design_value: colNumeric(cv, COLUMNS.designValue),
    design_start: design.from,
    design_end: design.to,
    construction_start: construction.from,
    construction_end: construction.to,
    notes: notesParts.length > 0 ? notesParts.join(" · ") : null,
    _groupTitle: groupTitle,
    _mapped: Boolean(stage),
  };
}

async function main() {
  console.log("============================================================");
  console.log("RESLU Spec System — Monday leads import");
  console.log(`Board: ${BOARD_ID}`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE — writing to Supabase"}`);
  console.log("============================================================\n");

  if (!process.env.MONDAY_API_TOKEN) {
    console.error("MONDAY_API_TOKEN is not set. Aborting.");
    process.exit(1);
  }
  if (!DRY_RUN) {
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
      console.error(
        "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for a live run. Aborting."
      );
      process.exit(1);
    }
  }

  console.log("Fetching items from Monday…");
  const items = await fetchAllItems();
  console.log(`Fetched ${items.length} items.\n`);

  const leads = items.map(mapItemToLead);

  const unmapped = leads.filter((l) => !l._mapped);
  const mapped = leads.filter((l) => l._mapped);

  console.log(`Mapped:   ${mapped.length}`);
  console.log(`Unmapped: ${unmapped.length} (will import into default stage 'Potential Lead' with a note — see below)\n`);

  if (unmapped.length > 0) {
    console.log("Unmapped groups encountered:");
    const groups = [...new Set(unmapped.map((l) => l._groupTitle))];
    for (const g of groups) {
      console.log(`  - "${g}" (${unmapped.filter((l) => l._groupTitle === g).length} item(s))`);
    }
    console.log("");
  }

  console.log("Sample of mapped rows:");
  for (const lead of leads.slice(0, 5)) {
    console.log(
      `  [${lead._groupTitle}] -> ${lead.stage ?? "Potential Lead (default)"} | ${lead.surname_project} | ${
        lead.first_name ?? "—"
      } | ${lead.location ?? "—"} | construction=${lead.construction_value ?? "—"} design=${
        lead.design_value ?? "—"
      }`
    );
  }
  console.log("");

  if (DRY_RUN) {
    console.log("Dry run complete. No data was written. Set DRY_RUN=0 to import for real.");
    return;
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(`Upserting ${leads.length} leads into Supabase (conflict target: monday_item_id)…`);

  let ok = 0;
  let failed = 0;
  // Upsert one at a time (not a single bulk upsert) so a single bad row
  // doesn't abort the whole import and so progress/errors are clearly
  // attributable to a specific Monday item in the console output —
  // this board is small enough (leads, not FF&E items) that per-row
  // round trips are not a performance concern.
  for (const lead of leads) {
    const row = { ...lead };
    delete row._groupTitle;
    delete row._mapped;
    if (row.stage === undefined) delete row.stage; // let the DB default apply

    const { error } = await supabase.from("leads").upsert(row, { onConflict: "monday_item_id" });
    if (error) {
      failed++;
      console.error(`  FAILED  ${lead.surname_project} (${lead.monday_item_id}): ${error.message}`);
    } else {
      ok++;
    }
  }

  console.log(`\nDone. ${ok} upserted, ${failed} failed.`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Import failed:", err.message ?? err);
  process.exit(1);
});
