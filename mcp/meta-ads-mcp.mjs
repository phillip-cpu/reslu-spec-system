#!/usr/bin/env node
/**
 * Meta Marketing API MCP Server — RESLU / Marco
 *
 * Full read/write access through Meta's Graph API using RESLU's existing
 * system-user token. The token is injected by the connector and never exposed
 * as a tool argument or returned in tool output.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fs from "fs";

const ENV_PATH = "/Users/vale/.openclaw/workspace/meta/.env";

function loadEnv(filePath) {
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) out[match[1]] = match[2].trim();
  }
  return out;
}

const env = loadEnv(ENV_PATH);
const ACCESS_TOKEN = env.META_ACCESS_TOKEN;
const rawAccountId = String(env.META_AD_ACCOUNT_ID ?? "").trim();
const AD_ACCOUNT_ID = rawAccountId.startsWith("act_") ? rawAccountId : `act_${rawAccountId}`;
const DEFAULT_API_VERSION = env.META_GRAPH_VERSION || "v21.0";

if (!ACCESS_TOKEN || !rawAccountId) {
  throw new Error("META_ACCESS_TOKEN and META_AD_ACCOUNT_ID are required");
}

function normalizeVersion(value) {
  const version = String(value || DEFAULT_API_VERSION).trim();
  if (!/^v\d+\.\d+$/.test(version)) throw new Error("api_version must look like v21.0");
  return version;
}

function normalizePath(value) {
  const path = String(value ?? "").trim().replace(/^\/+/, "");
  if (!path) throw new Error("path is required");
  if (path.includes("..") || /^https?:/i.test(path)) {
    throw new Error("path must be a relative Meta Graph API path");
  }
  return path;
}

function encodeValue(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function scrubSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => key.toLowerCase() !== "access_token")
      .map(([key, child]) => [key, scrubSecrets(child)]));
  }
  if (typeof value === "string") {
    return value.replace(/([?&]access_token=)[^&]+/gi, "$1<redacted>");
  }
  return value;
}

async function graphRequest({ method, path, params, apiVersion }) {
  const version = normalizeVersion(apiVersion);
  const relativePath = normalizePath(path);
  const input = params && typeof params === "object" && !Array.isArray(params) ? params : {};
  if (Object.keys(input).some((key) => key.toLowerCase() === "access_token")) {
    throw new Error("access_token is connector-managed and cannot be overridden");
  }

  const encoded = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) encoded.set(key, encodeValue(value));
  encoded.set("access_token", ACCESS_TOKEN);

  const upperMethod = String(method || "GET").toUpperCase();
  const baseUrl = `https://graph.facebook.com/${version}/${relativePath}`;
  const request = { method: upperMethod, headers: { Accept: "application/json" } };
  let url = baseUrl;
  if (upperMethod === "GET" || upperMethod === "DELETE") {
    url += `?${encoded.toString()}`;
  } else {
    request.headers["Content-Type"] = "application/x-www-form-urlencoded";
    request.body = encoded.toString();
  }

  const response = await fetch(url, request);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text };
  }
  const safeBody = scrubSecrets(body);
  if (!response.ok || body?.error) {
    const error = body?.error ?? safeBody;
    throw new Error(`Meta API ${upperMethod} ${relativePath} failed (${response.status}): ${JSON.stringify(scrubSecrets(error))}`);
  }
  return { api_version: version, method: upperMethod, path: relativePath, response: safeBody };
}

const server = new Server(
  { name: "meta-ads", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "meta_ads_account",
      description:
        "Return the fixed RESLU Meta Ads account identifier and current account metadata. " +
        "Use this as the starting point for Meta Ads work.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          fields: {
            type: "string",
            default: "id,name,account_id,account_status,currency,timezone_name,amount_spent,balance",
          },
          api_version: { type: "string", pattern: "^v[0-9]+\\.[0-9]+$" },
        },
      },
    },
    {
      name: "meta_ads_api",
      description:
        "Full Meta Marketing API access for RESLU. Run GET, POST, or DELETE requests against campaigns, " +
        "ad sets, ads, creatives, audiences, pixels, insights, budgets, statuses, targeting, assets, and " +
        "other Meta Ads resources permitted by RESLU's system-user token. Use the fixed account path returned " +
        "by meta_ads_account for account edges, or an object ID returned by a prior read for object updates. " +
        "The connector injects credentials automatically; never include an access token. Verify live state with " +
        "a GET after every write or delete.",
      inputSchema: {
        type: "object",
        required: ["method", "path"],
        additionalProperties: false,
        properties: {
          method: { type: "string", enum: ["GET", "POST", "DELETE"] },
          path: {
            type: "string",
            minLength: 1,
            description: "Relative Graph API path, such as act_ACCOUNT_ID/campaigns or a campaign/ad set/ad ID",
          },
          params: {
            type: "object",
            additionalProperties: true,
            description: "Graph API query or mutation parameters; objects and arrays are JSON-encoded",
          },
          api_version: {
            type: "string",
            pattern: "^v[0-9]+\\.[0-9]+$",
            description: `Optional Graph API version; defaults to ${DEFAULT_API_VERSION}`,
          },
          change_reference: {
            type: "string",
            description: "Optional request, approval, ticket, or conversation reference for Marco's receipt",
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === "meta_ads_account") {
      const result = await graphRequest({
        method: "GET",
        path: AD_ACCOUNT_ID,
        params: { fields: args.fields || "id,name,account_id,account_status,currency,timezone_name,amount_spent,balance" },
        apiVersion: args.api_version,
      });
      return { content: [{ type: "text", text: JSON.stringify({ ...result, ad_account_id: AD_ACCOUNT_ID }, null, 2) }] };
    }

    if (name === "meta_ads_api") {
      const result = await graphRequest({
        method: args.method,
        path: args.path,
        params: args.params,
        apiVersion: args.api_version,
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...result,
            change_reference: args.change_reference ?? null,
            verification_required: String(args.method).toUpperCase() !== "GET",
          }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: error.message ?? String(error) }) }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
