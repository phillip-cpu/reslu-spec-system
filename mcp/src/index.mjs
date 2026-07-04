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
  return cachedAccessToken;
}

async function getAccessToken() {
  if (cachedAccessToken) return cachedAccessToken;
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
    // than looping.
    cachedAccessToken = null;
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
      "Create a task card on a project's kanban board. column_id must be an existing board_columns id for that project — call get_project or the project's board API first if you don't already know it.",
    inputSchema: {
      type: "object",
      properties: {
        project_id: { type: "string", description: "Project UUID" },
        column_id: { type: "string", description: "Target board_columns UUID" },
        title: { type: "string" },
        description: { type: "string" },
        assignee_id: { type: "string", description: "Profile UUID to assign, optional" },
        contact_id: { type: "string", description: "Linked Address Book contact UUID, optional" },
        due_date: { type: "string", description: "ISO date, YYYY-MM-DD, optional" },
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
