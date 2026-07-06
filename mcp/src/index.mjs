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
      "Record a QUOTED trade price on a spec register item (admin-gated — Aria's account qualifies). Writes price_trade + stamps trade_price_received_at today, and appends the quote reference to the item's notes for the audit trail. GUARDRAILS by design: never writes price_rrp (scraper/manual territory), never writes markup or client pricing (Phillip's), and never records ACTUAL paid amounts — actuals flow exclusively through the invoice queue (create_invoice → human approval). Quantity/supplier updates ride along only when the quote changes them.",
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
        notes: {
          type: "string",
          description:
            "Quote reference, expiry, conditions — e.g. 'Demor Q-10718, valid 30 days'. Strongly encouraged.",
        },
      },
      required: ["item_id", "unit_price_ex_gst"],
      additionalProperties: false,
    },
    handler: async ({ item_id, unit_price_ex_gst, quantity, supplier, notes } = {}) => {
      const patch = {
        price_trade: unit_price_ex_gst,
        trade_price_received_at: new Date().toISOString().slice(0, 10),
      };
      if (typeof quantity === "number") patch.quantity = quantity;
      if (supplier) patch.supplier = supplier;
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
  {
    name: "get_needs_attention",
    description:
      "Get the four needs-attention lead groups: nurture (Proposal Sent >=4 days), stale_proposals (Awaiting to Send Proposal >=7 days), follow_ups_due (follow-up date today or past), site_visits_upcoming (next 7 days). This is the exact endpoint the lead-nurturer and lead-monitor automations should poll.",
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
        assignee_email: {
          type: "string",
          description:
            "Team member email to assign, optional — resolved against the team roster (case-insensitive exact match). Omit to auto-assign the calling account (Aria), matching create_board_task's own auto-assign-on-create behaviour.",
        },
      },
      required: ["title", "group"],
      additionalProperties: false,
    },
    handler: async ({ title, group, description, due_date, assignee_email }) => {
      const board = await apiFetch("/api/office");
      const target = board.groups.find((g) => g.name.toLowerCase().includes(group.trim().toLowerCase()));
      if (!target) {
        const names = board.groups.map((g) => g.name).join(", ");
        throw new Error(`No Office group matches "${group}". Valid groups: ${names}`);
      }

      const body = { group_id: target.id, title, description, due_date };
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
        assignee_email: {
          type: "string",
          description:
            "Team member email to assign, optional — resolved against the team roster (case-insensitive exact match). Omit to auto-assign the calling account (Aria).",
        },
      },
      required: ["project_id", "phase", "title"],
      additionalProperties: false,
    },
    handler: async ({ project_id, phase, title, description, due_date, assignee_email }) => {
      const design = await apiFetch(`/api/projects/${project_id}/design`);
      const target = design.phases.find((p) =>
        p.name.toLowerCase().includes(phase.trim().toLowerCase())
      );
      if (!target) {
        const names = design.phases.map((p) => p.name).join(", ");
        throw new Error(`No Design phase matches "${phase}" for this project. Valid phases: ${names}`);
      }

      const body = { design_phase_id: target.id, title, description, due_date };
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
];

const toolsByName = new Map(TOOLS.map((t) => [t.name, t]));

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
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
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
