#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { buildGenericRequest, buildLandingRequest, readFunnel, runReport } from "./ga4-core.mjs";

const server = new Server({ name: "ga4", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "ga4_funnel",
      description: "Read the RESLU /begin form events and landing-page views from the fixed GA4 property. Detects impossible event ordering and refuses to present broken instrumentation as a valid conversion funnel. Read-only.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { days: { type: "integer", minimum: 1, maximum: 366, default: 30 } },
      },
    },
    {
      name: "ga4_landing_pages",
      description: "Read RESLU landing-page sessions, users, engagement, page views, bounce rate, and GA4 key events for a date range, optionally filtered to one GA4 default channel group. Read-only; key events are not CRM-qualified leads.",
      inputSchema: {
        type: "object",
        required: ["start_date", "end_date"],
        additionalProperties: false,
        properties: {
          start_date: { type: "string" },
          end_date: { type: "string" },
          channel: { type: "string", description: "Exact GA4 default channel group, for example Organic Search or Paid Search" },
          limit: { type: "integer", minimum: 1, maximum: 250, default: 50 },
        },
      },
    },
    {
      name: "ga4_run_report",
      description: "Run a bounded read-only GA4 Data API report against RESLU's fixed property. Use when the funnel or landing-page tools do not expose the dimensions or metrics needed. No property or credential can be supplied by the caller.",
      inputSchema: {
        type: "object",
        required: ["start_date", "end_date", "dimensions", "metrics"],
        additionalProperties: false,
        properties: {
          start_date: { type: "string" },
          end_date: { type: "string" },
          dimensions: { type: "array", minItems: 1, maxItems: 9, items: { type: "string" } },
          metrics: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
          dimension_filter: { type: "object" },
          metric_filter: { type: "object" },
          order_bys: { type: "array", maxItems: 5, items: { type: "object" } },
          limit: { type: "integer", minimum: 1, maximum: 250, default: 50 },
          keep_empty_rows: { type: "boolean", default: false },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    if (name === "ga4_funnel") result = await readFunnel(args);
    else if (name === "ga4_landing_pages") result = await runReport(buildLandingRequest(args));
    else if (name === "ga4_run_report") result = await runReport(buildGenericRequest(args));
    else throw new Error(`Unknown tool: ${name}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error?.message || String(error) }) }] };
  }
});

await server.connect(new StdioServerTransport());
