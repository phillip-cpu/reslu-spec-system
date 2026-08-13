#!/usr/bin/env node
/**
 * Google Search Console MCP Server — RESLU / Marco
 *
 * Wraps GSC Search Analytics API (v3) and URL Inspection API (v1)
 * with read-only access for the sc-domain:reslu.com.au property.
 *
 * Token:  /Users/vale/.openclaw/workspace/search-console/token.json
 * Creds:  /Users/vale/.openclaw/workspace/gmail/credentials.json
 * Site:   sc-domain:reslu.com.au
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import fs from "fs";

const SITE_URL      = "sc-domain:reslu.com.au";
const TOKEN_PATH    = "/Users/vale/.openclaw/workspace/search-console/token.json";
const CREDS_PATH    = "/Users/vale/.openclaw/workspace/gmail/credentials.json";

function makeAuth() {
  const creds  = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8"));
  const token  = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
  const { client_id, client_secret, redirect_uris } = creds.installed;
  const auth   = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  auth.setCredentials(token);
  // Persist refreshed tokens automatically
  auth.on("tokens", (updated) => {
    try {
      const stored  = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...stored, ...updated }, null, 2));
    } catch (_) {}
  });
  return auth;
}

// ── Server ─────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "gsc", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gsc_query_performance",
      description:
        "Query Google Search Console performance data for reslu.com.au. " +
        "Returns clicks, impressions, CTR, and average position. " +
        "Dimensions: query, page, country, device, date, searchAppearance. " +
        "GSC data lags ~2–3 days — avoid querying the last 3 days.",
      inputSchema: {
        type: "object",
        required: ["startDate", "endDate"],
        properties: {
          startDate: { type: "string", description: "Start date YYYY-MM-DD" },
          endDate:   { type: "string", description: "End date YYYY-MM-DD" },
          dimensions: {
            type: "array",
            items: {
              type: "string",
              enum: ["query", "page", "country", "device", "date", "searchAppearance"]
            },
            description: "Group-by dimensions. Omit for site-wide aggregate totals."
          },
          rowLimit:  { type: "number", description: "Max rows to return (default 25, max 25000)" },
          startRow:  { type: "number", description: "Pagination offset (default 0)" },
          dimensionFilterGroups: {
            type: "array",
            description: "Optional filters. E.g. [{filters:[{dimension:'query',operator:'contains',expression:'renovation'}]}]"
          }
        }
      }
    },
    {
      name: "gsc_list_sitemaps",
      description:
        "List all sitemaps submitted for reslu.com.au. " +
        "Returns each sitemap's URL, type, last downloaded time, and indexed/submitted URL counts.",
      inputSchema: { type: "object", properties: {} }
    },
    {
      name: "gsc_inspect_url",
      description:
        "Inspect the live indexing status of a specific reslu.com.au URL. " +
        "Returns coverage verdict (PASS/FAIL/NEUTRAL), last crawl time, " +
        "canonical URL, robots.txt status, and indexing state.",
      inputSchema: {
        type: "object",
        required: ["inspectionUrl"],
        properties: {
          inspectionUrl: {
            type: "string",
            description: "Full URL to inspect, e.g. https://www.reslu.com.au/begin/renovation"
          }
        }
      }
    },
    {
      name: "gsc_list_sites",
      description:
        "List all Search Console properties the authorised account has access to. " +
        "Useful to confirm property names and access levels.",
      inputSchema: { type: "object", properties: {} }
    }
  ]
}));

// ── Tool handlers ───────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    const auth = makeAuth();

    // ── gsc_query_performance ─────────────────────────────────────────────
    if (name === "gsc_query_performance") {
      const wm  = google.webmasters({ version: "v3", auth });
      const res = await wm.searchanalytics.query({
        siteUrl: SITE_URL,
        requestBody: {
          startDate:  args.startDate,
          endDate:    args.endDate,
          dimensions: args.dimensions ?? [],
          rowLimit:   Math.min(args.rowLimit ?? 25, 25000),
          startRow:   args.startRow   ?? 0,
          ...(args.dimensionFilterGroups
            ? { dimensionFilterGroups: args.dimensionFilterGroups }
            : {})
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }

    // ── gsc_list_sitemaps ─────────────────────────────────────────────────
    if (name === "gsc_list_sitemaps") {
      const wm  = google.webmasters({ version: "v3", auth });
      const res = await wm.sitemaps.list({ siteUrl: SITE_URL });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }

    // ── gsc_inspect_url ───────────────────────────────────────────────────
    if (name === "gsc_inspect_url") {
      const sc  = google.searchconsole({ version: "v1", auth });
      const res = await sc.urlInspection.index.inspect({
        requestBody: {
          inspectionUrl: args.inspectionUrl,
          siteUrl:       SITE_URL
        }
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }

    // ── gsc_list_sites ────────────────────────────────────────────────────
    if (name === "gsc_list_sites") {
      const wm  = google.webmasters({ version: "v3", auth });
      const res = await wm.sites.list();
      return { content: [{ type: "text", text: JSON.stringify(res.data, null, 2) }] };
    }

    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true
    };

  } catch (err) {
    return {
      content: [{ type: "text", text: `GSC error (${name}): ${err.message}` }],
      isError: true
    };
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
