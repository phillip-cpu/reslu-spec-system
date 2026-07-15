#!/usr/bin/env node
// ============================================================
// RESLU Spec System — MCP server for Aria (OpenClaw)
// BUILD-SPEC.md §"Agent control — Aria": "Phase 2: thin MCP server
// wrapping the API (projects, items, notes, statuses, PDFs, imports)
// so Aria — or any Claude agent — can drive the system natively via
// tools rather than raw HTTP." + §"Week 10 — Aria API layer": "MCP
// server: repo subfolder mcp/ ... exposing tools: list_projects,
// get_project, list_items, create_item, update_item_status,
// list_leads, move_lead_stage, get_needs_attention, list_invoices,
// create_invoice, post_client_update, list_contacts,
// create_board_task. Each tool = thin fetch to the REST API with
// Aria's JWT; env: SPEC_URL, ARIA_EMAIL, ARIA_PASSWORD."
//
// This package is installed and run on Aria's Mac mini — NOT in this
// sandbox, and NOT as a dependency of the main Next.js app (it has its
// own package.json, per BUILD-SPEC.md: "installed on the mini, not in
// sandbox"). It cannot be executed or verified here; every design
// choice below favours defensiveness and readability over cleverness
// so correctness can be checked by reading, per this build's
// constraints.
//
// Design:
//   - Every tool handler is a thin `fetch()` to the REST API — no
//     business logic is duplicated here. The API is the single source
//     of truth for validation, admin gating, etc.
//   - Auth: lazy sign-in via supabase-js `signInWithPassword` using
//     ARIA_EMAIL/ARIA_PASSWORD, cached until the access token expires
//     or a request returns 401, at which point ONE re-auth + retry is
//     attempted (never an infinite loop).
//   - Tool schemas are plain JSON Schema objects (no zod) — this
//     package deliberately avoids a zod dependency; the low-level
//     `Server` class (not the high-level `McpServer`) accepts plain
//     JSON Schema for `inputSchema` and needs no zod at all for tool
//     definitions.
//   - Errors are ALWAYS returned as tool error content
//     (`{ isError: true, content: [...] }`), never thrown out of a
//     tool handler — a thrown error from a handler would surface as a
//     malformed MCP response instead of a clean, model-readable error
//     message.
// ============================================================

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createClient } from "@supabase/supabase-js";

// ------------------------------------------------------------
// Environment
// ------------------------------------------------------------
const SPEC_URL = process.env.SPEC_URL;
const ARIA_EMAIL = process.env.ARIA_EMAIL;
const ARIA_PASSWORD = process.env.ARIA_PASSWORD;
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

function checkEnv() {
  const missing = [];
  if (!SPEC_URL) missing.push("SPEC_URL");
  if (!ARIA_EMAIL) missing.push("ARIA_EMAIL");
  if (!ARIA_PASSWORD) missing.push("ARIA_PASSWORD");
  if (!SUPABASE_URL) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!SUPABASE_ANON_KEY) missing.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  if (missing.length > 0) {
    console.error(
      `[reslu-spec-mcp] Missing required environment variables: ${missing.join(", ")}.\n` +
        "See mcp/README.md for setup instructions. Exiting."
    );
    process.exit(1);
  }
}

// ------------------------------------------------------------
// Auth — lazy sign-in, cached token, retry-once-on-401.
//
// A single supabase-js client (anon key — this is a normal user
// sign-in, not a service-role client) is created once. The access
// token is fetched lazily on first use and cached; if the API ever
// responds 401 (token expired/revoked), authState is cleared and the
// caller re-authenticates and retries the SAME request exactly once —
// never in an unbounded loop, so a persistently wrong password fails
// fast with a clear error instead of hammering Supabase Auth.
// ------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let cachedAccessToken = null;
// Fix round B — BUILD-SPEC.md §"Phase 14 follow-ups" point 5 (audit
// backlog, deferred from 14B): "MCP 24h re-auth". Tracks when the
// cached token was minted so getAccessToken() below can force a fresh
// sign-in once it's stale, independent of the existing 401-triggered
// re-auth (that one only fires reactively, AFTER the API has already
// rejected a request with a now-invalid token; this is a proactive
// cap so a long-lived MCP server process — Aria's Mac mini runs this
// continuously, not per-request — never holds onto the same access
// token indefinitely just because it happens to keep working).
let cachedAccessTokenAt = null;
const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

async function signIn() {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: ARIA_EMAIL,
    password: ARIA_PASSWORD,
  });
  if (error || !data.session) {
    throw new Error(
      `Failed to sign in as Aria (${ARIA_EMAIL}): ${error?.message ?? "no session returned"}`
    );
  }
  cachedAccessToken = data.session.access_token;
  cachedAccessTokenAt = Date.now();
  return cachedAccessToken;
}

async function getAccessToken() {
  const isStale = cachedAccessTokenAt !== null && Date.now() - cachedAccessTokenAt >= TOKEN_MAX_AGE_MS;
  if (cachedAccessToken && !isStale) return cachedAccessToken;
  if (isStale) {
    cachedAccessToken = null;
    cachedAccessTokenAt = null;
  }
  return signIn();
}

/**
 * Thin authenticated fetch against the Spec System REST API.
 * `path` is joined onto SPEC_URL (e.g. "/api/leads?stage=..."). On a
 * 401, forces exactly one re-sign-in + retry before giving up.
 * Returns the parsed JSON body on success; throws a plain Error with
 * a clear message on any failure (callers catch this and turn it into
 * tool error content — this function itself never talks MCP).
 */
async function apiFetch(path, options = {}) {
  const url = `${SPEC_URL}${path}`;
  const attempt = async () => {
    const token = await getAccessToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
        Authorization: `Bearer ${token}`,
      },
    });
    return res;
  };

  let res = await attempt();

  if (res.status === 401) {
    // Token likely expired/revoked — clear cache, re-auth once, retry
    // the exact same request once. If it 401s again, give up rather
    // than looping. Clears cachedAccessTokenAt alongside the token
    // itself so the two stay consistent (getAccessToken()'s 24h
    // staleness check reads cachedAccessTokenAt, not just presence of
    // cachedAccessToken).
    cachedAccessToken = null;
    cachedAccessTokenAt = null;
    res = await attempt();
  }

  let body = null;
  try {
    body = await res.json();
  } catch {
    // Non-JSON response (e.g. a 500 HTML error page) — fall through
    // with body = null; the error message below still reports status.
  }

  if (!res.ok) {
    const message = body?.error ?? `HTTP ${res.status} ${res.statusText}`;
    throw new Error(`${options.method ?? "GET"} ${path} failed: ${message}`);
  }

  return body;
}

// ------------------------------------------------------------
// Tool definitions
//
// Each entry: { name, description, inputSchema (plain JSON Schema),
// handler(args) -> returns a JS value to be JSON-stringified into the
// tool result text }. Kept in one flat array so tools/list and
// tools/call share a single source of truth — no risk of the two
// drifting apart.
// ------------------------------------------------------------

const TOOLS = [
  {
    name: "list_projects",
    description:
      "List all active (non-archived) projects. Returns id, name, client_name, address, status, and cover image URL for each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/projects"),
  },
  {
    name: "get_project",
    description: "Get full detail for a single project by id.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}`),
  },
  {
    name: "list_items",
    description:
      "List spec register items for a project (design data only — no pricing; use the Pricing & Procurement view in the UI for financials, which this tool does not expose).",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/items`),
  },
  {
    name: "create_item",
    description:
      "Create a new spec register item on a project. item_code is generated automatically — do not pass one.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        category: { type: "string", description: "Category prefix, e.g. FA, SW, LI (see /api/categories)" },
        name: { type: "string" },
        description: { type: "string" },
        supplier: { type: "string" },
        location: { type: "string", description: "Room/location, e.g. 'ENSUITE'" },
        quantity: { type: "number" },
        product_url: { type: "string", description: "Product page URL — triggers a best-effort scrape" },
      },
      required: ["project_id", "category", "name"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/items`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  {
    name: "update_item_status",
    description:
      "Update a spec register item's procurement status (Specced/Quoted/Ordered/On Site/Installed). Triggers the existing one-way Monday sync on a transition to 'Ordered', same as the UI.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Item UUID" },
        status: {
          type: "string",
          enum: ["Specced", "Quoted", "Ordered", "On Site", "Installed"],
        },
      },
      required: ["item_id", "status"],
      additionalProperties: false,
    },
    handler: async ({ item_id, status }) =>
      apiFetch(`/api/items/${item_id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
  },
  {
    name: "update_item_pricing",
    description:
      "Record a QUOTED trade price on a spec register item (admin-gated — Aria's account qualifies). Writes price_trade + stamps trade_price_received_at today, and appends the quote reference to the item's notes for the audit trail. GUARDRAILS by design: never writes price_rrp (scraper/manual territory), never writes markup or client pricing (Phillip's), and never records ACTUAL paid amounts — actuals flow exclusively through the invoice queue (create_invoice → human approval). Quantity/supplier updates ride along only when the quote changes them. Order-by engine (8 July 2026): pass lead_time_weeks whenever the supplier's quote states one — trade quotes are exactly where lead times are learned, so recording it here (rather than only via the P&P UI) closes the 'missing lead time' gap at quoting time, before any trade is even booked, per BUILD-SPEC.md's 'lead-time hygiene happens at quoting time, not in a panic at booking time'.",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Item UUID" },
        unit_price_ex_gst: {
          type: "number",
          description: "Quoted trade price per unit, ex GST",
        },
        quantity: {
          type: "number",
          description: "Optional — only if the quote changes the quantity",
        },
        supplier: {
          type: "string",
          description: "Optional — only if quoting supplier differs from the spec",
        },
        lead_time_weeks: {
          type: "number",
          description:
            "Optional — the supplier's stated lead time in weeks (may be fractional, e.g. 2.5). Feeds the order-by engine (lib/order-by.ts): without this, an item with a trade booking still shows 'set lead time' rather than a real order-by date. Record it whenever the quote states one.",
        },
        notes: {
          type: "string",
          description:
            "Quote reference, expiry, conditions — e.g. 'Demor Q-10718, valid 30 days'. Strongly encouraged.",
        },
      },
      required: ["item_id", "unit_price_ex_gst"],
      additionalProperties: false,
    },
    handler: async ({ item_id, unit_price_ex_gst, quantity, supplier, lead_time_weeks, notes } = {}) => {
      const patch = {
        price_trade: unit_price_ex_gst,
        trade_price_received_at: new Date().toISOString().slice(0, 10),
      };
      if (typeof quantity === "number") patch.quantity = quantity;
      if (supplier) patch.supplier = supplier;
      if (typeof lead_time_weeks === "number") patch.lead_time_weeks = lead_time_weeks;
      const result = await apiFetch(`/api/items/${item_id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
      if (notes) {
        // Audit trail: quote reference lands as an attributed item note,
        // not a silent field overwrite.
        await apiFetch(`/api/items/${item_id}/notes`, {
          method: "POST",
          body: JSON.stringify({ text: `Trade price recorded: $${unit_price_ex_gst} ex GST — ${notes}` }),
        });
      }
      return result;
    },
  },
  {
    name: "create_project",
    description:
      "Create a new project. Prefer the leads flow ('Progress to job' on a lead) when the project comes from the pipeline — it prepopulates client contacts/budget and links the lead. Use this tool for projects with no lead history. Returns the created project incl. its id and client portal token.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Project name, e.g. 'Goldsworthy'" },
        client_name: { type: "string" },
        address: { type: "string" },
        client_email: { type: "string" },
        client_phone: { type: "string" },
        budget: { type: "number", description: "Whole-project budget ex GST (optional)" },
        alias: { type: "string", description: "Internal alias, e.g. 'Nth Adelaide townhouse'" },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: async (args = {}) =>
      apiFetch("/api/projects", {
        method: "POST",
        body: JSON.stringify(args),
      }),
  },
  {
    name: "list_leads",
    description:
      "List leads (admin-only — Aria's account has admin role for this, see BUILD-SPEC.md). Optional filters: stage (one of the 10 pipeline stages), q (search), since (ISO timestamp — only leads created at or after this time, for a lead-monitor automation polling loop).",
    inputSchema: {
      type: "object",
      properties: {
        stage: {
          type: "string",
          description:
            "Exact stage match, e.g. 'Proposal Sent'. See get_needs_attention / the leads pipeline docs for the full 10-stage list.",
        },
        q: { type: "string", description: "Free-text search across name/location/email/phone" },
        since: { type: "string", description: "ISO timestamp — only leads created at/after this time" },
      },
      additionalProperties: false,
    },
    handler: async ({ stage, q, since } = {}) => {
      const params = new URLSearchParams();
      if (stage) params.set("stage", stage);
      if (q) params.set("q", q);
      if (since) params.set("since", since);
      const qs = params.toString();
      return apiFetch(`/api/leads${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "move_lead_stage",
    description:
      "Move a lead to a new pipeline stage. Writes a lead_stage_events row automatically (drives avg-days-in-stage reporting). Returns the updated lead and its stage-change history.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID" },
        stage: {
          type: "string",
          enum: [
            "Potential Lead",
            "Site Visit Booked",
            "Awaiting to Send Proposal",
            "Proposal Sent",
            "Design Work In Progress",
            "Construction In Progress",
            "Unable to Contact",
            "Lead Lost",
            "Complete",
            "Potential Future Lead",
          ],
        },
      },
      required: ["lead_id", "stage"],
      additionalProperties: false,
    },
    handler: async ({ lead_id, stage }) =>
      apiFetch(`/api/leads/${lead_id}/stage`, {
        method: "POST",
        body: JSON.stringify({ stage }),
      }),
  },
  // ------------------------------------------------------------
  // Migration 030 round (7 July 2026) — lead_notes, mirroring the
  // existing item-notes pattern (POST /api/items/[id]/notes has no
  // MCP tool of its own today, but this is the exact same thin-fetch
  // shape). Use this for logging call/email outcomes against a lead —
  // see docs/ARIA.md's own worked example.
  // ------------------------------------------------------------
  {
    name: "update_lead",
    description:
      "Update a lead's fields (admin-gated — Aria's account qualifies). Whitelisted fields only: follow_up_date, site_visit_date, email, phone, location, construction_value, design_value. Stage changes use move_lead_stage; notes use add_lead_note. Added 8 Jul after Aria couldn't correct a follow-up date.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string" },
        follow_up_date: { type: "string", description: "YYYY-MM-DD" },
        site_visit_date: { type: "string", description: "YYYY-MM-DD" },
        email: { type: "string" },
        phone: { type: "string" },
        location: { type: "string" },
        construction_value: { type: "number" },
        design_value: { type: "number" },
      },
      required: ["lead_id"],
      additionalProperties: false,
    },
    handler: async ({ lead_id, ...fields } = {}) =>
      apiFetch(`/api/leads/${lead_id}`, {
        method: "PATCH",
        body: JSON.stringify(fields),
      }),
  },
  {
    name: "add_lead_note",
    description:
      "Add an attributed, timestamped note to a lead — e.g. logging the outcome of a call or email. Admin-only (leads are admin-only, financial-adjacent, same as every other leads route/tool). Distinct from move_lead_stage: this never changes the lead's stage, just appends to its notes feed.",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID" },
        text: { type: "string", description: "Note text, e.g. 'Called 7 Jul — no answer, left voicemail.'" },
      },
      required: ["lead_id", "text"],
      additionalProperties: false,
    },
    handler: async ({ lead_id, text }) =>
      apiFetch(`/api/leads/${lead_id}/notes`, {
        method: "POST",
        body: JSON.stringify({ text }),
      }),
  },
  // ------------------------------------------------------------
  // Site capture + mobile QoL round (r21) — BUILD-SPEC.md item 5's
  // "ALSO fix" clause: "Aria cannot read lead notes — expose lead
  // notes through get_lead/list_leads or a get_lead_notes tool
  // (read-only, whatever matches existing MCP conventions)."
  //
  // Root cause (found by reading, not guessed): GET /api/leads/[id]/
  // notes has existed since migration 030 (lead_notes table) — the
  // route itself was never the gap. add_lead_note (just above) has
  // always been able to WRITE to that feed via its POST sibling; no
  // tool ever called the matching GET. This is a thin fetch to that
  // existing route, same shape as list_site_photos below — no API
  // change needed, the read path already worked, it just had no MCP
  // door.
  // ------------------------------------------------------------
  {
    name: "get_lead_notes",
    description:
      "Read the attributed, timestamped notes feed for a lead (newest first) — e.g. before calling a lead back, to see what was last discussed. Admin-only (leads are admin-only, financial-adjacent, same as every other leads route/tool). Read-only — pairs with add_lead_note (write) and move_lead_stage (stage changes, never touches notes).",
    inputSchema: {
      type: "object",
      properties: {
        lead_id: { type: "string", description: "Lead UUID" },
      },
      required: ["lead_id"],
      additionalProperties: false,
    },
    handler: async ({ lead_id }) => apiFetch(`/api/leads/${lead_id}/notes`),
  },
  {
    name: "get_needs_attention",
    description:
      "Get the four needs-attention LEAD groups: nurture (Proposal Sent >=4 days), stale_proposals (Awaiting to Send Proposal >=7 days), follow_ups_due (follow-up date today or past), site_visits_upcoming (next 7 days). This is the exact endpoint the lead-nurturer and lead-monitor automations should poll. NOTE — for CHASING OVERDUE ORDERS/BOOKINGS (not leads), use get_bookings_overdue (cross-project, trade booking confirmations) and get_ordering_attention (per-project, order-by deadlines + missing lead times) instead — those are separate tools with their own groups, not part of this one's four lead groups.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/leads/attention"),
  },
  {
    name: "list_invoices",
    description:
      "List invoices for a project (admin-only, financial). Optional status filter: unmatched, proposed, approved, rejected.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        status: {
          type: "string",
          enum: ["unmatched", "proposed", "approved", "rejected"],
        },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, status }) =>
      apiFetch(`/api/projects/${project_id}/invoices${status ? `?status=${status}` : ""}`),
  },
  {
    name: "create_invoice",
    description:
      "Create (extract) an invoice record for a project — admin-only, financial. Use this after parsing an incoming supplier invoice email/PDF. amount_ex_gst is required; gst/total will be computed by the caller's own extraction if provided.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        supplier: { type: "string" },
        invoice_number: { type: "string" },
        invoice_date: { type: "string", description: "ISO date, YYYY-MM-DD" },
        amount_ex_gst: { type: "number" },
        gst: { type: "number" },
        total: { type: "number" },
        confidence_note: {
          type: "string",
          description: "Free-text note on extraction confidence, e.g. 'OCR unclear on invoice_number'",
        },
      },
      required: ["project_id", "supplier", "invoice_number", "amount_ex_gst"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/invoices`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Booking selection v2 + Aria supplier invoices (r24). BUILD-SPEC.md
  // §"Booking selection v2 + Aria supplier invoices (r24)", item 5:
  // Second Brain's email pipeline flags a likely supplier invoice
  // (attachment/pdf + amount/invoice-number heuristics) on an
  // ALREADY-INGESTED email — you read the attachment, extract the
  // fields, work out which project it belongs to and (if you can) which
  // cost line or spec item it matches, then call this tool.
  //
  // HARD RULE, enforced in code (not just by you reading this): this
  // tool is a thin POST to the SAME route create_invoice above calls
  // (POST /api/projects/[id]/invoices) — read that route's own doc
  // comment if you want to verify this yourself. It only ever INSERTs a
  // draft row. There is no tool, no route, and no code path reachable
  // from here that applies a cost, writes a cost_line/item, or updates
  // a library product's price — that only ever happens when a human
  // clicks Approve in the Invoice queue UI. Calling this tool is
  // exactly as safe as flagging an email for a human's attention; it
  // never moves money or changes anything else in the system.
  // ------------------------------------------------------------
  {
    name: "propose_supplier_invoice",
    description:
      "Propose a DRAFT supplier invoice (money OUT) extracted from an already-ingested email — for the Invoice queue's Aria pipeline (BUILD-SPEC.md r24). Creates a row with source='aria', status='proposed' if you also pass a match, marked 'Aria · needs approval' in the queue UI. INSERT ONLY — nothing is applied to any cost/item/library record until a human clicks Approve in the UI; you cannot bypass that gate with this tool. source_email_id is required — every proposed invoice must trace back to the email it came from. If you can identify which cost_line or item this invoice covers, pass proposed_match_type + proposed_match_id (use list_invoices' sibling read tools / the project's own estimate to find candidates first) — the queue UI shows your proposed match for the human to confirm or change before approving.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID this invoice belongs to — your best match from the email's job hints (address, job number, contact name mentioned)" },
        source_email_id: { type: "string", description: "emails.id (Second Brain, already-ingested) this was extracted from — required, this is the traceability link a human reviews it against" },
        supplier: { type: "string" },
        invoice_number: { type: "string" },
        invoice_date: { type: "string", description: "ISO date, YYYY-MM-DD" },
        amount_ex_gst: { type: "number", description: "Ex-GST amount — the canonical figure Approve applies" },
        gst: { type: "number", description: "Omit to let the server compute 10% of amount_ex_gst" },
        total: { type: "number", description: "Omit to let the server compute amount_ex_gst + gst" },
        abn: { type: "string", description: "Supplier's ABN, if visible on the invoice — stored in `extracted`, not a canonical column" },
        line_hints: { type: "string", description: "Free text — which line items/work this invoice covers, and why you think so" },
        job_hints: { type: "string", description: "Free text — what in the email told you which project this belongs to (address, job number, contact name, etc)" },
        proposed_match_type: { type: "string", enum: ["cost_line", "item"], description: "Omit if you can't confidently match — the invoice still lands in the queue as 'unmatched' for a human to match manually" },
        proposed_match_id: { type: "string", description: "cost_lines.id or items.id, matching proposed_match_type — must belong to the same project_id" },
        confidence_note: { type: "string", description: "Free text — anything about the extraction/match a human reviewer should know, e.g. 'ABN partly obscured by a coffee stain, verify supplier'" },
      },
      required: ["project_id", "source_email_id", "supplier", "invoice_number", "amount_ex_gst"],
      additionalProperties: false,
    },
    handler: async ({ project_id, abn, line_hints, job_hints, ...body }) => {
      const extracted = {};
      if (abn !== undefined) extracted.abn = abn;
      if (line_hints !== undefined) extracted.line_hints = line_hints;
      if (job_hints !== undefined) extracted.job_hints = job_hints;
      if (body.supplier !== undefined) extracted.supplier = body.supplier;
      if (body.invoice_number !== undefined) extracted.invoice_number = body.invoice_number;
      if (body.invoice_date !== undefined) extracted.invoice_date = body.invoice_date;
      return apiFetch(`/api/projects/${project_id}/invoices`, {
        method: "POST",
        body: JSON.stringify({ ...body, source: "aria", extracted }),
      });
    },
  },
  {
    name: "post_client_update",
    description:
      "Create a client-portal update post (draft — not published/visible to the client until published in the UI). Body/title only; this tool does not publish.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string" },
        body_richtext: { type: "string" },
      },
      required: ["project_id", "title", "body_richtext"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/client-updates/posts`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Phase 11B — Diary workflow (BUILD-SPEC.md §"Phase 11 — Diary" /
  // §"mobile pass"): staff write rough notes + pick 1-2 photos from the
  // site gallery on their phone -> a draft portal_updates row is
  // created (status 'draft') -> Aria calls draft_diary_entry to fetch
  // the rough notes + linked photo captions, writes a polished
  // title+body, then calls draft_diary_entry AGAIN with that polished
  // copy to submit it, which flips the row to status
  // 'pending_approval' -> a human takes it from there (single-tap
  // Publish in the client area / project overview — Aria NEVER
  // publishes; see docs/ARIA.md's "she drafts — never publishes"
  // section).
  //
  // One tool, two modes, mirroring BUILD-SPEC's own phrasing ("MCP tool
  // draft_diary_entry: fetches draft + photo captions, returns polished
  // title+body, sets status 'pending_approval'") as a single named
  // tool: calling it WITHOUT title/body_richtext fetches (read mode);
  // calling it WITH both submits the polished copy (write mode). This
  // keeps the tool surface to the one name the spec names, while still
  // letting Aria read-then-think-then-write across two separate calls
  // (a single call can't both return content for the model to read AND
  // accept content the model hasn't generated yet in the same turn).
  // ------------------------------------------------------------
  {
    name: "draft_diary_entry",
    description:
      "Two modes, same tool. FETCH mode (omit title/body_richtext): returns a diary draft's rough notes and linked gallery-photo captions, ready for Aria to turn into a polished magazine-style entry (serif headline + short story). SUBMIT mode (pass title + body_richtext): saves Aria's polished copy onto that same draft and sets its status to 'pending_approval' — NOT published yet; a human must one-tap Publish it in the client area before it appears on the client portal. Aria never publishes diary entries herself. Only works on entries currently in status 'draft'.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        update_id: {
          type: "string",
          description:
            "portal_updates row id — get this from project context or by asking which project's diary draft to work on; drafts are visible in the team client area UI.",
        },
        title: { type: "string", description: "SUBMIT mode only — polished, magazine-style headline" },
        body_richtext: {
          type: "string",
          description: "SUBMIT mode only — polished short story, markdown (paragraphs/bold/lists only)",
        },
      },
      required: ["project_id", "update_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id, update_id, title, body_richtext }) => {
      const path = `/api/projects/${project_id}/client-updates/posts/${update_id}/aria-draft`;
      if (typeof title === "string" && typeof body_richtext === "string") {
        return apiFetch(path, { method: "POST", body: JSON.stringify({ title, body_richtext }) });
      }
      return apiFetch(path);
    },
  },
  {
    name: "list_site_photos",
    description:
      "List a project's internal site-photo gallery (staged photos, some published to the client portal, some not) — so Aria can see what's available when drafting a diary entry or choosing which photos to reference. Read-only; does not fetch image bytes, just captions/dates/URLs.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/site-photos`),
  },
  // ------------------------------------------------------------
  // Site capture + mobile QoL round (r21) — BUILD-SPEC.md item 5:
  // "list_pending_transcriptions, set_capture_transcript(capture_id,
  // transcript), list_site_captures(project)." Distinct from
  // list_site_photos above: site_captures (migration 050) is a
  // separate table from site_photos, fed by /capture and the
  // /trade/[token] capture section (photo/note/audio, one Site diary
  // per project — app/(dashboard)/projects/[id]/diary/), not the
  // internal staging gallery.
  // ------------------------------------------------------------
  {
    name: "list_pending_transcriptions",
    description:
      "List audio site-captures still queued for transcription (transcript_status='pending'), oldest first — the queue Aria's Mac mini (local Whisper, no external AI) polls. Each entry: id, project_id, project_name, a signed audio URL, created_at. Call set_capture_transcript once a transcript is ready for one of these.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/site-captures/pending-transcriptions"),
  },
  {
    name: "set_capture_transcript",
    description:
      "Attach a finished transcript to an audio site-capture — sets transcript_status='done'. Only valid for audio captures (400s otherwise). Use after locally transcribing a recording returned by list_pending_transcriptions.",
    inputSchema: {
      type: "object",
      properties: {
        capture_id: { type: "string", description: "site_captures UUID (the audio row)" },
        transcript: { type: "string", description: "The finished transcript text" },
      },
      required: ["capture_id", "transcript"],
      additionalProperties: false,
    },
    handler: async ({ capture_id, transcript }) =>
      apiFetch(`/api/site-captures/${capture_id}/transcript`, {
        method: "PATCH",
        body: JSON.stringify({ transcript }),
      }),
  },
  {
    name: "list_site_captures",
    description:
      "List a project's Site diary — every photo/note/audio capture from BOTH /capture (team) and the /trade/[token] capture section (trade contacts), reverse-chronological (most recent first). Each entry carries kind, signed url/thumb_url (photo/audio only), text_content (notes), transcript/transcript_status (audio), and who captured it (author).",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/site-captures`),
  },
  {
    name: "list_contacts",
    description:
      "List Address Book contacts (trades & suppliers) — team-visible, not financial. Optional filters: q (search), category.",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        category: { type: "string" },
      },
      additionalProperties: false,
    },
    handler: async ({ q, category } = {}) => {
      const params = new URLSearchParams();
      if (q) params.set("q", q);
      if (category) params.set("category", category);
      const qs = params.toString();
      return apiFetch(`/api/contacts${qs ? `?${qs}` : ""}`);
    },
  },
  {
    name: "create_board_task",
    description:
      "Create a task card on a project's kanban board. column_id must be an existing board_columns id for that project — call get_project or the project's board API first if you don't already know it. Board v2 (Phase 12a-B): auto-assigns Aria herself if assignee_ids is omitted entirely — pass assignee_ids: [] for no assignee, or a list of profile UUIDs to assign specific people instead.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        column_id: { type: "string", description: "Target board_columns UUID" },
        title: { type: "string" },
        description: { type: "string" },
        assignee_ids: {
          type: "array",
          items: { type: "string" },
          description: "Profile UUIDs to assign, optional — omit to auto-assign Aria's own account (Board v2 auto-assign-on-create), pass [] for none.",
        },
        contact_id: { type: "string", description: "Linked Address Book contact UUID, optional" },
        due_date: { type: "string", description: "ISO date, YYYY-MM-DD, optional" },
        due_time: { type: "string", description: "migration 041 — optional wall-clock reminder time alongside due_date, 'HH:MM' (24h), e.g. '14:30'. Ignored if due_date is omitted." },
        phase_group_id: { type: "string", description: "Board v2 phase-group UUID, optional — see the project's board response for available groups" },
      },
      required: ["project_id", "column_id", "title"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/board`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Phase 12a-A — SOW completion + Aria plan analysis + takeoff assist
  // (BUILD-SPEC.md §"SOW completion + Aria plan analysis", §"Aria
  // takeoff assist"). Three new tools, all thin fetches like every
  // tool above — the deterministic cross-reference engine and takeoff
  // maths live server-side (lib/takeoff.ts), never in this file.
  // ------------------------------------------------------------
  {
    name: "list_pending_plan_analyses",
    description:
      "List a project's uploaded plan files (project_files kind 'plans') that have never been analysed yet, with signed URLs so Aria can open and read them. This is the queue Aria's plan-analysis automation polls.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/plan-analysis/pending`),
  },
  {
    name: "submit_plan_analysis",
    description:
      "Submit Aria's extraction results for one plan file: room names found on the plans, item codes referenced, and (optional) stated dimensions per room. The server runs a deterministic cross-reference against the spec register (both directions, plus room-name mismatches) and stores the discrepancies — never guessed, only computed from what's actually submitted here. When dimensions are supplied, the server ALSO computes draft takeoff quantities (floor/painting/tiling m²) and writes them to Areas & Measurements with status 'draft' — never auto-verified; a human site-measure confirms them later. Never publishes or issues anything.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        file_id: { type: "string", description: "project_files UUID of the analysed plan file (must be kind 'plans')" },
        revision_label: { type: "string", description: "e.g. 'T3', optional" },
        rooms: {
          type: "array",
          items: { type: "string" },
          description: "Room names found annotated on the plan set",
        },
        item_codes: {
          type: "array",
          items: { type: "string" },
          description: "FF&E item codes found referenced on the plan set",
        },
        dimensions: {
          type: "array",
          description:
            "Stated dimension annotations per room, where present. Omit a room entirely if no dimension was annotated for it — the system flags it as 'measure on site' rather than guessing.",
          items: {
            type: "object",
            properties: {
              room_name: { type: "string" },
              length_m: { type: "number" },
              width_m: { type: "number" },
              height_m: { type: "number", description: "Ceiling height, metres — defaults to 2.4 if omitted" },
              opening_count: { type: "number", description: "Door/window openings, for the painting area allowance" },
              wet_area: { type: "boolean", description: "True to also compute a tiling m² figure (floor + walls to stated height)" },
            },
            required: ["room_name"],
            additionalProperties: false,
          },
        },
        analysed_by: { type: "string", description: "Defaults to 'Aria' in practice — free text" },
      },
      required: ["project_id", "file_id", "rooms", "item_codes"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/plan-analysis`, {
        method: "POST",
        body: JSON.stringify({ analysed_by: "Aria", ...body }),
      }),
  },
  {
    name: "draft_sow_section",
    description:
      "Two modes, same tool. FETCH mode (omit `lines`): returns the project's current rooms, each room's assigned FF&E items, the latest plan analysis's discrepancies (if any), and the room-section clause pattern skeleton to follow — everything needed to draft a grounded room-by-room SOW section. SUBMIT mode (pass `section_id` + `lines`): writes each line onto that EXISTING draft sow_sections row (create the section itself first via the normal SOW builder API/UI, then call this to populate it) — every line lands with the SAME draft status as any hand-typed line; nothing is issued or published by this tool. Only works while the parent SOW is still a draft.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID — FETCH mode" },
        section_id: {
          type: "string",
          description: "SUBMIT mode only — an existing sow_sections UUID to write lines onto (create it first via POST /api/projects/[id]/sow/[sowId]/sections)",
        },
        lines: {
          type: "array",
          description: "SUBMIT mode only — the lines to write, in order",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              kind: { type: "string", enum: ["inclusion", "exclusion", "note"] },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    handler: async ({ project_id, section_id, lines }) => {
      if (section_id && Array.isArray(lines)) {
        const results = [];
        for (const line of lines) {
          results.push(
            await apiFetch(`/api/sow/sections/${section_id}/lines`, {
              method: "POST",
              body: JSON.stringify(line),
            })
          );
        }
        return { section_id, lines_created: results.length, lines: results };
      }
      if (!project_id) {
        throw new Error("FETCH mode requires project_id; SUBMIT mode requires section_id + lines.");
      }
      return apiFetch(`/api/projects/${project_id}/sow/draft-context`);
    },
  },
  // ------------------------------------------------------------
  // Phase 12a-B — client_events (BUILD-SPEC.md §"Portal — upcoming
  // client meetings": "Team manages from the project client area (and
  // Aria via API/MCP create_client_event — she already books
  // meetings)."). Thin fetch, same shape as create_board_task above.
  // ------------------------------------------------------------
  {
    name: "create_client_event",
    description:
      "Create a client meeting/event, shown on the client portal's 'Upcoming meetings' card (date, time, location, notes) and reminded to the client by email the day before. notes is CLIENT-FACING — write it as portal copy, not an internal note.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        title: { type: "string", description: "e.g. 'Selections meeting — studio'" },
        starts_at: { type: "string", description: "ISO timestamp" },
        ends_at: { type: "string", description: "ISO timestamp, optional" },
        location: { type: "string" },
        notes: { type: "string", description: "Client-facing — shown verbatim on the portal card" },
      },
      required: ["project_id", "title", "starts_at"],
      additionalProperties: false,
    },
    handler: async ({ project_id, ...body }) =>
      apiFetch(`/api/projects/${project_id}/client-events`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Phase 13 — Office board (BUILD-SPEC.md §"13 Office",
  // docs/OFFICE-BRIEF.md). The Office board is GLOBAL (no project_id at
  // all) — this is exactly Aria's stated "outstanding items" pattern
  // from the brief: "Any actionable item from email, WhatsApp, or
  // conversation that doesn't belong on a job board goes on the Office
  // board" and her "creates Monday items for actionable inbound work
  // and resolves them within 24-48 hours" automation description. See
  // docs/ARIA.md's new "Office board (Phase 13)" section for the full
  // workflow write-up.
  //
  // Both tools below fetch GET /api/office once to resolve free-text
  // arguments (group name, assignee email) against the live board,
  // rather than requiring Aria to already know internal UUIDs — the
  // brief specifically asks for "group name fuzzy-match" since Aria
  // (or whoever prompts her) will say "put this on Meta Ads", not quote
  // a group_id.
  // ------------------------------------------------------------
  {
    name: "create_office_task",
    description:
      "Create a task on the Office board (global business-housekeeping board — Marketing, Website, Meta Ads, Google Ads, Operations, Systems & Tech, Phillip, Archived). Use this for Aria's 'outstanding items' pattern: any actionable item from email/WhatsApp/conversation that doesn't belong on a client project board. group matches a department name loosely (case-insensitive substring, e.g. 'meta' matches 'Meta Ads') — if nothing matches, the call fails with the current list of valid group names so you can retry. assignee_email is optional and resolved against the team roster; omit it to auto-assign nobody in particular (the API itself auto-assigns the calling account, i.e. Aria, unless assignee_email is given).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        group: {
          type: "string",
          description:
            "Department name, fuzzy-matched case-insensitively against the current Office groups (e.g. 'website', 'meta', 'phillip'). Do not pass 'Archived' — new tasks should never be filed directly into Archived.",
        },
        description: { type: "string" },
        due_date: { type: "string", description: "ISO date, YYYY-MM-DD, optional" },
        due_time: { type: "string", description: "migration 041 — optional wall-clock reminder time alongside due_date, 'HH:MM' (24h), e.g. '14:30'. Ignored if due_date is omitted." },
        assignee_email: {
          type: "string",
          description:
            "Team member email to assign, optional — resolved against the team roster (case-insensitive exact match). Omit to auto-assign the calling account (Aria), matching create_board_task's own auto-assign-on-create behaviour.",
        },
      },
      required: ["title", "group"],
      additionalProperties: false,
    },
    handler: async ({ title, group, description, due_date, due_time, assignee_email }) => {
      const board = await apiFetch("/api/office");
      const target = board.groups.find((g) => g.name.toLowerCase().includes(group.trim().toLowerCase()));
      if (!target) {
        const names = board.groups.map((g) => g.name).join(", ");
        throw new Error(`No Office group matches "${group}". Valid groups: ${names}`);
      }

      const body = { group_id: target.id, title, description, due_date, due_time };
      if (assignee_email) {
        const member = board.team.find(
          (t) => t.email && t.email.toLowerCase() === assignee_email.trim().toLowerCase()
        );
        if (!member) {
          throw new Error(`No team member found with email "${assignee_email}".`);
        }
        body.assignee_ids = [member.id];
      }

      return apiFetch("/api/office/tasks", { method: "POST", body: JSON.stringify(body) });
    },
  },
  {
    name: "list_office_tasks",
    description:
      "List Office board tasks (global business-housekeeping board), optionally filtered by department group name (fuzzy match, same as create_office_task) and open/completed status. Standing rule cards (kind 'rule', e.g. 'DO NOT enable Google AI Max') are included and clearly marked — they are never 'completed'.",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "Department name, fuzzy-matched (e.g. 'operations') — omit for all groups" },
        status: { type: "string", enum: ["open", "completed"], description: "Omit for both" },
      },
      additionalProperties: false,
    },
    handler: async ({ group, status } = {}) => {
      const board = await apiFetch("/api/office");
      let groups = board.groups;
      if (group) {
        groups = groups.filter((g) => g.name.toLowerCase().includes(group.trim().toLowerCase()));
      }
      const tasks = groups.flatMap((g) =>
        g.tasks.map((t) => ({ ...t, group_name: g.name }))
      );
      if (!status) return { tasks };
      if (status === "completed") return { tasks: tasks.filter((t) => !!t.completed_at) };
      return { tasks: tasks.filter((t) => !t.completed_at) };
    },
  },
  // ------------------------------------------------------------
  // Phase 12b — Design Framework (BUILD-SPEC.md §"12b Design
  // Framework", docs/DESIGN-FRAMEWORK-BRIEF.md). Per-project design
  // pipeline — the 7 brief phases (Project Milestones, Presentation,
  // Concepts, 3D Working Model, WD Package, Renders, Sampling &
  // Furniture), each with its own task list. Distinct from
  // create_board_task/create_office_task: this is Tenille and Phillip's
  // internal design checklist, never a quoting surface — no
  // pricing/cost field exists anywhere on a design task.
  //
  // list_design_phases fetches a project's Design tab in one call
  // (seeding the 7 phases on first call for that project, same as the
  // Design tab's own first-visit behaviour — see
  // GET /api/projects/[id]/design's doc comment). create_design_task
  // then fuzzy-matches a phase name against that same live list, same
  // "fuzzy-match against a live GET first" pattern create_office_task
  // uses for department groups — Aria (or whoever prompts her) will say
  // "add a task to WD Package", not quote a design_phase_id UUID.
  // ------------------------------------------------------------
  {
    name: "list_design_phases",
    description:
      "List a project's Design Framework phases (Project Milestones, Presentation, Concepts, 3D Working Model, WD Package, Renders, Sampling & Furniture) with their tasks, statuses, and assignees. Seeds the 7 standard phases on the first call for a project that has none yet (same as opening its Design tab for the first time). Read-only — no pricing/cost data is ever included, this is a design-workflow checklist, not a quoting surface.",
    inputSchema: {
      type: "object",
      properties: { project_id: { type: "string", description: "Project UUID" } },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/design`),
  },
  {
    name: "create_design_task",
    description:
      "Create a task under one of a project's Design Framework phases. phase matches a phase name loosely (case-insensitive substring, e.g. 'wd' matches 'WD Package', 'renders' matches 'Renders') against that project's live phase list — if nothing matches, the call fails with the current list of valid phase names so you can retry. assignee_email is optional and resolved against the team roster; omitting it falls through to the API's own auto-assign-on-create (the calling account, i.e. Aria, is assigned automatically), matching create_board_task's and create_office_task's identical behaviour.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        phase: {
          type: "string",
          description:
            "Design phase name, fuzzy-matched case-insensitively against that project's current Design phases (e.g. 'concepts', 'wd package', '3d').",
        },
        title: { type: "string" },
        description: { type: "string" },
        due_date: { type: "string", description: "ISO date, YYYY-MM-DD, optional" },
        due_time: { type: "string", description: "migration 041 — optional wall-clock reminder time alongside due_date, 'HH:MM' (24h), e.g. '14:30'. Ignored if due_date is omitted." },
        assignee_email: {
          type: "string",
          description:
            "Team member email to assign, optional — resolved against the team roster (case-insensitive exact match). Omit to auto-assign the calling account (Aria).",
        },
      },
      required: ["project_id", "phase", "title"],
      additionalProperties: false,
    },
    handler: async ({ project_id, phase, title, description, due_date, due_time, assignee_email }) => {
      const design = await apiFetch(`/api/projects/${project_id}/design`);
      const target = design.phases.find((p) =>
        p.name.toLowerCase().includes(phase.trim().toLowerCase())
      );
      if (!target) {
        const names = design.phases.map((p) => p.name).join(", ");
        throw new Error(`No Design phase matches "${phase}" for this project. Valid phases: ${names}`);
      }

      const body = { design_phase_id: target.id, title, description, due_date, due_time };
      if (assignee_email) {
        const member = design.team.find(
          (t) => t.email && t.email.toLowerCase() === assignee_email.trim().toLowerCase()
        );
        if (!member) {
          throw new Error(`No team member found with email "${assignee_email}".`);
        }
        body.assignee_ids = [member.id];
      }

      return apiFetch("/api/design-tasks", { method: "POST", body: JSON.stringify(body) });
    },
  },
  // ------------------------------------------------------------
  // Board cockpit round (7 July 2026) — "Aria booking-chase attention
  // feed 'bookings_overdue' + MCP tool book_trade_visit." Both thin
  // fetches like every tool above — the overdue-chase rule
  // (lib/board-cockpit.ts computeBookingsOverdue) and the booking
  // validation (phase/contact/date checks) live server-side, never
  // duplicated here.
  // ------------------------------------------------------------
  {
    name: "get_bookings_overdue",
    description:
      "Aria's booking-chase attention feed: board cards with an overdue, still-unconfirmed trade booking (booking_date in the past, linked visit status still unconfirmed/tentative/proposed_change), or an overdue milestone card (kind='milestone' with a past due_date). Use this to find bookings that need chasing across ALL projects — no project_id filter, this is a cross-project feed like get_needs_attention.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/board-tasks/attention"),
  },
  // ------------------------------------------------------------
  // Order-by engine (Phillip, 8 July 2026) — "product deadlines from
  // trade bookings." An item a trade installs must be ordered
  // [lead time] before that trade's works date (lib/order-by.ts). This
  // tool is the chase-list equivalent of get_bookings_overdue above,
  // for ORDERING rather than booking-confirmation: 'ordering_due' items
  // (order_by date due within 7 days or already past) and a
  // 'missing_lead_times' count+link (items with no lead_time_weeks set
  // at all, flagged even before any trade is booked, so the gap gets
  // fixed at quoting time — see update_item_pricing's lead_time_weeks
  // arg above, the intended fix path for Aria specifically).
  //
  // UNLIKE get_bookings_overdue/get_needs_attention, this IS
  // project_id-scoped (GET /api/projects/[id]/attention, not a
  // cross-project feed) — order-by derivation depends on a project's
  // OWN trade bookings, so a cross-project version would need to either
  // fan out per-project internally or return an unbounded cross-project
  // dataset; scoping to one project at a time mirrors get_project's own
  // shape and keeps this tool's payload bounded. Aria should call
  // list_projects first, then call this per project of interest (e.g.
  // every active project) when building a chase list across the whole
  // studio.
  // ------------------------------------------------------------
  {
    name: "get_ordering_attention",
    description:
      "Order-by engine chase list for ONE project: 'ordering_due' (items whose order_by date — the trade's works date minus lead_time_weeks — is within 7 days or already past, sorted overdue-first) and 'missing_lead_times' (count + P&P deep link for unordered items with no lead_time_weeks set at all, regardless of booking status). Admin-gated (procurement data). Use alongside get_bookings_overdue to chase both booking confirmations AND order deadlines. When an item shows up here with no lead time, prefer fixing it via update_item_pricing's lead_time_weeks arg the next time you record that item's trade quote.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
      },
      required: ["project_id"],
      additionalProperties: false,
    },
    handler: async ({ project_id }) => apiFetch(`/api/projects/${project_id}/attention`),
  },
  // ------------------------------------------------------------
  // Daily Brief (Phillip, 8 July 2026, migration 041) —
  // BUILD-SPEC.md §"Daily Brief": "Aria appends via MCP add_brief_item
  // (title, source, link, project)." Thin fetch to POST
  // /api/brief/items, same shape as every other create_* tool above —
  // the actual dedupe/generation logic lives in
  // lib/daily-brief-generate.ts (the morning cron path), never
  // duplicated here; this tool is the OTHER way an item lands in the
  // brief, for a non-urgent item Aria notices mid-conversation/mid-
  // automation that doesn't need a same-minute WhatsApp ping. See
  // docs/ARIA.md's "Daily Brief" section for the worked example of
  // when to use this vs. WhatsApp.
  // ------------------------------------------------------------
  {
    name: "add_brief_item",
    description:
      "Append an item to today's Daily Brief (the single shared team brief on the My Work page) — for something Phillip should see and acknowledge this morning, but that ISN'T urgent enough to interrupt him on WhatsApp right now. Always lands with source 'aria' (attributed, distinct from the generator's own system-sourced booking/ordering/lead/trade items) and status 'open'. Use link_href to point at the real record (a project page, a lead, etc.) so 'open ->' on the panel goes somewhere useful — a title with no link still shows up fine, just without a deep link.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, scannable — this is a sticky-note line, not a task description." },
        link_href: { type: "string", description: "Optional deep link — e.g. '/projects/{id}?tab=ffe', '/leads'. Omit if there's nothing to link to." },
        project_id: { type: "string", description: "Optional — Project UUID, shown as a project chip on the brief row." },
      },
      required: ["title"],
      additionalProperties: false,
    },
    handler: async ({ title, link_href, project_id }) =>
      apiFetch("/api/brief/items", {
        method: "POST",
        body: JSON.stringify({ title, source: "aria", link_href, project_id }),
      }),
  },
  {
    name: "add_brain_note",
    description:
      "Store a durable, source-attributed business learning in Second Brain. Use this for reusable decisions, patterns, preferences or lessons—not transient reminders or unsupported guesses. Always include source/source_ref when available and an honest confidence score. The note becomes searchable after the next reindex (or call index_rebuild with entity_type='memory'). This is an internal knowledge write only; it never changes a client/project/financial record.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short, specific learning or decision title" },
        body: { type: "string", description: "What was learned, why it matters, and any conditions/expiry" },
        tags: { type: "array", items: { type: "string" }, description: "Optional search tags" },
        source: { type: "string", description: "Origin type, e.g. client_meeting, email, project_review, phillip" },
        source_ref: { type: "string", description: "Optional URL, record id, email id or dated file reference" },
        confidence: { type: "number", minimum: 0, maximum: 1, description: "0-1 confidence; omit only for explicit human decisions" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    handler: async (body) =>
      apiFetch("/api/second-brain/notes", {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // RESLU Second Brain, Step 2 (docs/RESLU-second-brain-build-brief.md).
  // aria_queue (migration 033) is Aria's own work queue — events other
  // parts of this app raise (price requests, trade reminders, lead
  // flags, approval-needed items, email proposals from a later step)
  // land there as rows; these two tools are how Aria drains it. Same
  // thin-fetch pattern as every tool in this file — the actual claim
  // logic (FOR UPDATE SKIP LOCKED, the 15-minute visibility timeout)
  // lives in the claim_aria_queue_items() Postgres function (migration
  // 034), called by POST /api/aria-queue/claim, never reimplemented
  // here or in that route.
  //
  // Heartbeat usage (per the brief): a Mac-mini script should check
  // whether the queue is non-empty (a cheap call — get_aria_queue
  // itself is that check; an empty `items` array costs one API round-
  // trip, not a model invocation) BEFORE ever invoking Aria on a
  // schedule, so idle polling costs zero tokens.
  // ------------------------------------------------------------
  {
    name: "get_aria_queue",
    description:
      "Claim up to `limit` pending work items from Aria's queue (oldest first) — atomically, so two concurrent callers never claim the same row. A row picked up more than 15 minutes ago and never resolved is treated as abandoned (Aria crashed mid-item) and is re-exposed here again. Empty result means nothing to do right now — check this before invoking any model on a schedule, not the other way around. Resolve every claimed item with resolve_queue_item once handled, whether it succeeded or failed.",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Max items to claim, default 10, capped at 50" },
      },
      additionalProperties: false,
    },
    handler: async ({ limit } = {}) =>
      apiFetch("/api/aria-queue/claim", {
        method: "POST",
        body: JSON.stringify(limit === undefined ? {} : { limit }),
      }),
  },
  {
    name: "resolve_queue_item",
    description:
      "Mark a claimed aria_queue item 'done' or 'failed'. Resolved rows are never deleted — they are this queue's own audit trail. Always resolve a claimed item (even a failure) so it doesn't sit picked-up until the 15-minute visibility timeout re-exposes it unnecessarily. `note` is optional context (e.g. why it failed, or what action was taken) stored on the row.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "aria_queue row UUID" },
        status: { type: "string", enum: ["done", "failed"] },
        note: { type: "string", description: "Optional context — why it failed, or what was done" },
      },
      required: ["id", "status"],
      additionalProperties: false,
    },
    handler: async ({ id, ...body }) =>
      apiFetch(`/api/aria-queue/${id}/resolve`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Fee proposal phase round (r23) — BUILD-SPEC.md §"Fee proposal phase
  // (r23)" item 5: "MCP tools get_proposal, set_proposal_draft (updates
  // content.letter/content.vision ONLY and ONLY while status='draft')."
  // Same thin-fetch pattern as every tool in this file — get_proposal is
  // a plain GET (admin-gated the same way every proposals route is;
  // Aria authenticates as a real admin user, docs/ARIA.md), and
  // set_proposal_draft targets the DELIBERATELY narrower
  // PATCH /api/proposals/[id]/draft (not the general
  // PATCH /api/proposals/[id] every other field group uses) — that
  // route itself enforces "letter/vision only, draft status only" at
  // the API layer, not just here, so this tool's own restriction can't
  // be bypassed by calling the route directly either. Draft a proposal
  // AFTER an aria_queue item of kind 'draft_proposal' surfaces via
  // get_aria_queue (raised by POST /api/proposals when the source lead
  // has brief_answers — migration 051 PART 3) — see docs/ARIA.md's own
  // "Fee proposal drafting" section for the full worked example.
  // ------------------------------------------------------------
  {
    name: "get_proposal",
    description:
      "Read one fee proposal's full content (letter, vision, scope sections, fees, timeline, exclusions, terms) plus its status/token/totals. Admin-only (fee proposals carry design-fee/pricing data). Use this to see the current draft before calling set_proposal_draft, or to check a proposal's status/token for any other reason.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "proposals row UUID (from a draft_proposal aria_queue item's payload.proposal_id)" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id }) => apiFetch(`/api/proposals/${id}`),
  },
  {
    name: "set_proposal_draft",
    description:
      "Draft (or redraft) a fee proposal's intro letter and/or project vision alignment paragraph — content.letter / content.vision ONLY, and ONLY while the proposal's status is still 'draft' (the route itself enforces both restrictions server-side, not just this tool). Never touches scope/fees/timeline/exclusions/terms, and can never send a proposal — Phillip always reviews and edits before pressing Send himself. Use get_lead_notes / get_lead / search first to ground the draft in the actual site visit — voice: warm, direct, confident, references the actual visit and specific rooms/aspects, 'quiet luxury', never salesy, no em dashes, middots ok, sign-off 'Phillip Introna, Director, RESLU' (see docs/proposal-reference-content.md's own 'Voice rules for Aria drafts').",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "proposals row UUID" },
        letter: { type: "string", description: "Full intro letter text, e.g. 'Dear Sam and Alex,\\n\\n...'" },
        vision: { type: "string", description: "Full PROJECT VISION ALIGNMENT paragraph text" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id, ...body }) =>
      apiFetch(`/api/proposals/${id}/draft`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // RESLU Second Brain, Step 12 (docs/RESLU-second-brain-build-brief.md).
  // Manual reindex trigger — invokes the Step 5 indexer route
  // directly (same Vercel deployment; the route already supports an
  // optional entity_type filter, added in Step 5 specifically so this
  // Step 12 tool would cost nothing extra to add later).
  // ------------------------------------------------------------
  {
    name: "index_rebuild",
    description:
      "Manually trigger a workspace_index reindex — normally runs on its own daily cron. Use this to force fresh search results after a bulk import or a new durable learning. Optional entity_type scopes the rebuild to one kind (project/lead/item/diary/sow/email/memory) instead of everything.",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: { type: "string", enum: ["project", "lead", "item", "diary", "sow", "email", "memory"], description: "Optional — scope to one entity type" },
      },
      additionalProperties: false,
    },
    handler: async ({ entity_type } = {}) =>
      apiFetch(entity_type ? `/api/second-brain/reindex?entity_type=${encodeURIComponent(entity_type)}` : "/api/second-brain/reindex"),
  },
  // ------------------------------------------------------------
  // RESLU Second Brain, Step 6 (docs/RESLU-second-brain-build-brief.md).
  // Hybrid (full-text + vector) search over workspace_index (Step 4/5)
  // — one call instead of 6-8 separate list/get round-trips to find a
  // project/lead/item/diary-entry/SOW-entry by name or description.
  // Same thin-fetch pattern as every tool above — the actual RRF
  // ranking lives in hybrid_search() (migration 036), the query
  // embedding call lives in POST /api/second-brain/search, neither
  // duplicated here.
  // ------------------------------------------------------------
  {
    name: "search",
    description:
      "Hybrid search (full-text + semantic) across projects, leads, items, diary/portal updates, SOW documents, inbound emails and durable memory notes. Use it before deciding or drafting so current records and prior decisions inform the answer. Full-text catches exact codes; semantic search catches paraphrases. Use entity_type to scope to project/lead/item/diary/sow/email/memory. response_format 'concise' (default) returns a <=140-char snippet per result; 'detailed' returns the full indexed content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text" },
        entity_type: { type: "string", enum: ["project", "lead", "item", "diary", "sow", "email", "memory"], description: "Optional — scope to one entity type" },
        limit: { type: "number", description: "Max results, default 8, capped at 30" },
        response_format: { type: "string", enum: ["concise", "detailed"], description: "Default concise" },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) =>
      apiFetch("/api/second-brain/search", {
        method: "POST",
        body: JSON.stringify(args),
      }),
  },
  // ------------------------------------------------------------
  // Phase 4 Project Health feed + RESLU Second Brain Step 7 context.
  // Both remain thin fetches: the business rules live in the Spec API.
  // Compact snapshot replacing 6-8 separate round-trips at the start
  // of a session. Same thin-fetch pattern — GET /api/me/context holds
  // the actual query/aggregation logic, not duplicated here.
  // ------------------------------------------------------------
  {
    name: "get_project_health",
    description:
      "Read the same Project Health diagnostics shown to admins in Spec. Omit project_id for every active project, or pass one project UUID for its full report. This is read-only: use it to investigate and propose corrections, never treat a warning as permission to change project data. Phase 4 already creates/refreshes deduplicated Office tasks for critical issues and upcoming unconfirmed trade visits.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: {
          type: "string",
          description: "Optional project UUID. Omit for the company-wide active-project feed.",
        },
      },
      additionalProperties: false,
    },
    handler: async ({ project_id } = {}) =>
      apiFetch(
        project_id
          ? `/api/projects/${encodeURIComponent(project_id)}/data-quality`
          : "/api/projects/data-quality"
      ),
  },
  {
    name: "get_context_snapshot",
    description:
      "Compact workspace snapshot for proactive review: active projects, active leads, actionable aria_queue items (including abandoned claims), pending change proposals, recent emails, recent diary updates and durable memory references. IDs + names + counts + one-liners only — use get_project_health for operational data-quality risks and search or record tools for detail. Pass project_id to expand one project with its items, real open-proposal count and recent matched emails.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Optional — expand one project instead of the full snapshot" },
      },
      additionalProperties: false,
    },
    handler: async ({ project_id } = {}) =>
      apiFetch(project_id ? `/api/me/context?project_id=${encodeURIComponent(project_id)}` : "/api/me/context"),
  },
  // ------------------------------------------------------------
  // RESLU Second Brain, Step 11 (docs/RESLU-second-brain-build-brief.md).
  // Approve/reject a pending change_proposals row — the human-in-the-
  // loop gate every price/lead-time fact from the email pipeline goes
  // through before it ever touches items. Same thin-fetch pattern —
  // the actual atomic write lives in approve_proposal() (migration
  // 040), never duplicated here.
  // ------------------------------------------------------------
  {
    name: "approve_proposal",
    description:
      "Approve a pending change_proposals row — atomically writes the proposed value to the matched item's field (price_trade or lead_time_weeks) and appends an audit_log row. Fails if the proposal is not pending (already resolved). Use get_aria_queue (kind='email_proposal') to find proposals waiting on Phillip.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "change_proposals row UUID" } },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id }) => apiFetch(`/api/second-brain/proposals/${id}/approve`, { method: "POST" }),
  },
  {
    name: "reject_proposal",
    description:
      "Reject a pending change_proposals row — never touches items. If the rejection is really 'wrong item was matched, not wrong price', separately correct the underlying match with the correct_match tool so the same mention doesn't misfire again.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "change_proposals row UUID" },
        note: { type: "string", description: "Optional reason for the rejection" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async ({ id, ...body }) =>
      apiFetch(`/api/second-brain/proposals/${id}/reject`, { method: "POST", body: JSON.stringify(body) }),
  },
  {
    name: "correct_match",
    description:
      "Correct a Step 10 entity match (email_entity_matches row, status 'review' or 'no_match') to the right entity — updates the match row and inserts an entity_aliases row, so the same mention text auto-links correctly next time without needing this correction repeated.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "email_entity_matches row UUID" },
        entity_id: { type: "string", description: "The correct project or item UUID this mention actually refers to" },
      },
      required: ["id", "entity_id"],
      additionalProperties: false,
    },
    handler: async ({ id, ...body }) =>
      apiFetch(`/api/second-brain/matches/${id}/correct`, { method: "POST", body: JSON.stringify(body) }),
  },
  {
    name: "book_trade_visit",
    description:
      "Book a trade visit directly from a board card (Board cockpit round). Creates a trade_visits row under the given phase and links it to the card (card.visit_id), also stamping the card's booking_date/booking_end_date so its status badge shows immediately. Fails if the card already has a booking linked — unlink it first (not exposed as an Aria tool; ask a team member to unlink from the Board UI) before rebooking. phase_id must belong to the same project as the card and must not be the Site Setup umbrella phase.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "board_tasks UUID (the card to book against)" },
        phase_id: { type: "string", description: "schedule_phases UUID — the phase this visit belongs to (must not be the Site Setup umbrella phase)" },
        contact_id: { type: "string", description: "Trade contact UUID, optional" },
        start_date: { type: "string", description: "ISO date, YYYY-MM-DD" },
        end_date: { type: "string", description: "ISO date, YYYY-MM-DD, same day or after start_date" },
        arrival_slot: { type: "string", enum: ["first_thing", "midday", "afternoon"], description: "Optional nominated arrival slot" },
        arrival_time: { type: "string", description: "Optional specific time, HH:MM:SS, overrides arrival_slot for display" },
        notes: { type: "string", description: "Optional internal notes for the visit" },
      },
      required: ["task_id", "phase_id", "start_date", "end_date"],
      additionalProperties: false,
    },
    handler: async ({ task_id, ...body }) =>
      apiFetch(`/api/board-tasks/${task_id}/book-visit`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
  },
  // ------------------------------------------------------------
  // Board cockpit round (7 July 2026) — "Bunnings/blocked-site
  // pricing" loop. bunnings.com.au and wilbrad.com.au are VERIFIED to
  // hang on a plain server-side fetch (not hypothetical) — POST
  // /api/materials/[id]/refresh-price now flags this instead of
  // failing silently (materials.price_refresh_status='needs_aria'),
  // and these two tools close the loop: one to see what's waiting, one
  // to resolve it. Same thin-fetch pattern as every tool above — no
  // business logic duplicated here.
  // ------------------------------------------------------------
  {
    name: "get_materials_needing_aria",
    description:
      "Materials whose last automated price refresh failed and is waiting on Aria (price_refresh_status='needs_aria') — typically because the supplier's product page hangs on a plain fetch (Bunnings/Wilbrad-type sites are known to do this). Use this to find pricing gaps to fill, then resolve each with submit_material_price.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/materials/attention"),
  },
  {
    name: "submit_material_price",
    description:
      "Supply a price for a material whose automated refresh failed (see get_materials_needing_aria). Updates the material's price and clears its 'needs_aria' outstanding-request state, the same as a successful automated scrape would. source_note, if given, REPLACES the material's notes field (materials have a single flat notes field, not an append-only log like item notes) — mention where the price came from (e.g. 'Bunnings product page, priced-checked by phone 7 Jul').",
    inputSchema: {
      type: "object",
      properties: {
        material_id: { type: "string", description: "materials UUID" },
        price: { type: "number", description: "New price, in dollars" },
        source_note: { type: "string", description: "Optional — where this price came from. Replaces the material's notes field." },
      },
      required: ["material_id", "price"],
      additionalProperties: false,
    },
    handler: async ({ material_id, price, source_note }) => {
      const patch = { price };
      if (source_note) patch.notes = source_note;
      return apiFetch(`/api/materials/${material_id}`, {
        method: "PATCH",
        body: JSON.stringify(patch),
      });
    },
  },
  // ------------------------------------------------------------
  // CPD tracker round (BUILD-SPEC.md "CPD point tracker"). Per
  // docs/ARIA.md's "CPD logging" section: when a webinar/course
  // confirmation email lands in the shared inbox, Aria logs it here
  // rather than leaving it for manual entry. Thin fetch to POST
  // /api/cpd, same shape as every create_* tool above — the actual
  // validation/year-window math lives in lib/cpd.ts, never duplicated
  // here.
  //
  // Every cpd_entries row needs a user_id (migration 047, not null),
  // but Aria only ever knows WHOSE inbox the confirmation email landed
  // in as an email address, not a profiles.id — so this tool resolves
  // user_email against GET /api/profiles first (same "fetch a live
  // list, then case-insensitive exact-match the email" pattern
  // create_office_task/create_design_task already use for
  // assignee_email), then passes the resolved id as POST /api/cpd's
  // admin-only `user_id` field. Aria's own account is admin (see
  // list_leads' doc comment), so this override is honoured server-side
  // — see that route's own doc comment for why a non-admin caller could
  // never do this.
  //
  // user_email defaults to Phillip's address when omitted (documented
  // here AND in docs/ARIA.md/README.md — CPD tracking launched with
  // exactly one licensed team member using it day-to-day; extend this
  // default, or start requiring user_email, once a second person is
  // regularly logging CPD via Aria).
  //
  // Evidence attachment is DEFERRED — this tool never sets
  // evidence_path (that needs the two-step signed-upload flow, which
  // has no natural fit inside a single MCP tool call over a chat
  // transcript); logging the confirmation email's existence via
  // `notes` is enough for now, per this round's brief ("evidence attach
  // deferred to her email pipeline later").
  // ------------------------------------------------------------
  {
    name: "add_cpd_entry",
    description:
      "Log a completed CPD (Continuing Professional Development) activity — e.g. from a webinar/course confirmation email. Resolves user_email against the team roster to attribute the entry (defaults to phillip@reslu.com.au if omitted — CPD tracking currently has one regular user). Does NOT attach evidence files (deferred — a future round will wire this into the email pipeline); mention the confirmation email in `notes` instead, e.g. 'Confirmation email from Master Builders, 10 Jul 2026'.",
    inputSchema: {
      type: "object",
      properties: {
        activity_title: { type: "string", description: "e.g. 'AS/NZS bathroom waterproofing webinar'" },
        provider: { type: "string", description: "Optional — the training provider/organiser" },
        activity_date: { type: "string", description: "ISO date, YYYY-MM-DD — when the activity took place" },
        points: { type: "number", description: "CPD points/hours earned, must be > 0 (fractional allowed, e.g. 1.5)" },
        category: {
          type: "string",
          description: "Optional free text — e.g. 'Technical', 'Business', 'Compliance', 'Safety' (suggestions only, not enforced)",
        },
        notes: { type: "string", description: "Optional — e.g. a reference to the confirmation email this was logged from" },
        user_email: {
          type: "string",
          description: "Team member's email to attribute this entry to. Omit to default to phillip@reslu.com.au.",
        },
      },
      required: ["activity_title", "activity_date", "points"],
      additionalProperties: false,
    },
    handler: async ({ user_email, ...body }) => {
      const targetEmail = (user_email || "phillip@reslu.com.au").trim().toLowerCase();
      const { profiles } = await apiFetch("/api/profiles");
      const match = profiles.find((p) => p.email && p.email.toLowerCase() === targetEmail);
      if (!match) {
        throw new Error(`No team member found with email "${targetEmail}".`);
      }
      return apiFetch("/api/cpd", {
        method: "POST",
        body: JSON.stringify({ ...body, user_id: match.id }),
      });
    },
  },
  // ------------------------------------------------------------
  // Health + web push round (r26) — BUILD-SPEC.md item 6: "MCP tools
  // (mini side talks through these): post_heartbeat,
  // report_channel_status, get_pending_diagnostics,
  // complete_diagnostic." Thin fetch wrappers over app/api/health/*,
  // same shape as every other tool in this file — no business logic
  // duplicated here, the route is the source of truth (incident
  // dedupe, pruning, status transitions all live server-side).
  //
  // NOTE for the reviewing manager (also in docs/MINI-HEALTH-
  // HANDOFF.md): the mini's actual automated heartbeat/diagnostics
  // loop is a plain bash+curl script hitting these same REST routes
  // directly, NOT going through this MCP server or any LLM call — see
  // that doc's "why not through Aria/MCP" note. These four tools exist
  // so Aria (the agent) can ALSO call them conversationally (e.g. she
  // notices something during an unrelated task and wants to report a
  // channel status by hand), but they are not the automated path.
  // ------------------------------------------------------------
  {
    name: "post_heartbeat",
    description:
      "Report a mini heartbeat (uptime/disk/mem/openclaw status/pending macOS updates). Normally sent by the mini's own dumb bash+curl script every ~5 minutes (docs/MINI-HEALTH-HANDOFF.md), not by Aria herself — this tool exists so you CAN post one conversationally if useful (e.g. right after a manual repair), but it is not part of any automated monitoring loop you need to run.",
    inputSchema: {
      type: "object",
      properties: {
        uptime: { type: "string", description: "Free text, e.g. output of `uptime`" },
        disk_free_gb: { type: "number" },
        mem_free_gb: { type: "number" },
        openclaw_up: { type: "boolean" },
        pending_updates: { type: "number", description: "Count of pending macOS updates (softwareupdate -l)" },
        extra: { type: "object", description: "Any additional free-form fields" },
      },
      additionalProperties: false,
    },
    handler: async (body = {}) => apiFetch("/api/health/heartbeat", { method: "POST", body: JSON.stringify(body) }),
  },
  {
    name: "report_channel_status",
    description:
      "Report the status of one monitored channel (WhatsApp group bridge, email, RESLU calendar). Upserts by `channel` (a stable machine key, e.g. 'whatsapp'/'email'/'calendar' — NOT a display label). A transition to 'degraded'/'down' or session_valid:false fires a deduped incident push to admins; a transition back to 'ok' (with session_valid true/omitted) auto-resolves any open incident for this channel.",
    inputSchema: {
      type: "object",
      properties: {
        channel: { type: "string", description: "Stable machine key, e.g. 'whatsapp', 'email', 'calendar'" },
        label: { type: "string", description: "Optional display label" },
        status: { type: "string", enum: ["ok", "degraded", "down"] },
        last_inbound_at: { type: "string", description: "ISO timestamp of the most recent inbound message/event" },
        last_outbound_at: { type: "string", description: "ISO timestamp of the most recent outbound message/event" },
        session_valid: { type: "boolean", description: "Whether the channel's login/session is still valid" },
        note: { type: "string" },
      },
      required: ["channel", "status"],
      additionalProperties: false,
    },
    handler: async (body) => apiFetch("/api/health/channel-status", { method: "POST", body: JSON.stringify(body) }),
  },
  {
    name: "get_pending_diagnostics",
    description:
      "List queued diagnostics/repair requests (health_diagnostics status='pending', oldest first) and claim them (flips them to 'running' as they're returned, so a second poll doesn't reprocess the same request). A request is queued when an admin presses 'Run diagnostics & repair' on the Health page. Call complete_diagnostic once you've worked one.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => apiFetch("/api/health/diagnostics/pending"),
  },
  {
    name: "complete_diagnostic",
    description:
      "Report the outcome of a diagnostics/repair run claimed via get_pending_diagnostics. status 'done' or 'failed'; `report` is free text (what was checked, what was restarted, current state) — its first ~200 characters are sent to admins as the completion push body, so lead with the headline. This is the mini's own repair loop (restart WhatsApp bridge, verify session, check softwareupdate -l — see docs/MINI-HEALTH-HANDOFF.md) — NOT a Claude Code repair session; those are Phillip's own separate, explicit button press outside this system.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "health_diagnostics UUID (from get_pending_diagnostics)" },
        status: { type: "string", enum: ["done", "failed"] },
        report: { type: "string" },
      },
      required: ["id", "status", "report"],
      additionalProperties: false,
    },
    handler: async ({ id, status, report }) =>
      apiFetch(`/api/health/diagnostics/${id}/complete`, {
        method: "POST",
        body: JSON.stringify({ status, report }),
      }),
  },
];

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------
// RESLU Second Brain, Step 12 (docs/RESLU-second-brain-build-brief.md)
// — "Truncation guard on every MCP tool: cap responses ~2,000 tokens
// with a message telling the agent how to narrow." Implemented once,
// centrally, at the single point every tool's result actually gets
// serialized (CallToolRequestSchema handler below) — not scattered
// across each of the ~40 individual tool handlers above, which would
// be both a much larger change and much easier to accidentally miss
// on the next new tool. ~4 chars/token is a rough, deliberately
// conservative estimate (a safety cap, not a precise token count) —
// erring toward truncating slightly early costs nothing; erring
// toward never truncating defeats the whole point.
// ------------------------------------------------------------
const MAX_RESPONSE_CHARS = 2000 * 4;

function truncateForResponse(text) {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return JSON.stringify(
    {
      truncated: true,
      message: `Response exceeded roughly 2,000 tokens (${text.length} chars) and was truncated. Narrow the request — a smaller limit, a more specific filter (e.g. entity_type, project_id), or response_format:'concise' if this tool supports it — then try again.`,
      preview: text.slice(0, MAX_RESPONSE_CHARS),
    },
    null,
    2
  );
}

// ------------------------------------------------------------
// MCP server wiring — low-level Server + StdioServerTransport,
// setRequestHandler for tools/list and tools/call. (The higher-level
// McpServer/registerTool API is more ergonomic but pulls in zod as a
// hard peer dependency for schema authoring; this server's tool
// schemas are plain JSON Schema objects, which the low-level Server's
// tools/list response accepts directly — no zod needed anywhere in
// this file.)
// ------------------------------------------------------------

async function main() {
  checkEnv();

  const server = new Server(
    { name: "reslu-spec-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolsByName.get(name);

    if (!tool) {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool: ${name}` }],
      };
    }

    try {
      const result = await tool.handler(args ?? {});
      const text = JSON.stringify(result, null, 2);
      return {
        content: [{ type: "text", text: truncateForResponse(text) }],
      };
    } catch (err) {
      // Never throw out of a tool handler — always return isError
      // content so the calling agent gets a clean, readable failure
      // message instead of a broken MCP response.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error("[reslu-spec-mcp] MCP server running on stdio.");
}

main().catch((err) => {
  console.error("[reslu-spec-mcp] Fatal error:", err instanceof Error ? err.message : err);
  process.exit(1);
});
