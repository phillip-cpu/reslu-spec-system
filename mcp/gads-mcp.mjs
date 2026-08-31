#!/usr/bin/env node
/**
 * Google Ads MCP Server — RESLU / Marco
 *
 * Reporting and approval-gated execution connector. Scoped hard to customer
 * 3357756972. Mutation tools are deliberately narrow and verify live state
 * after each approved change.
 *
 * Credentials: /Users/vale/.openclaw/workspace/google-ads/.env
 * google-ads-api:  /Users/vale/.openclaw/workspace/google-ads/node_modules/
 * MCP SDK:         /Users/vale/reslu-spec-system/mcp/node_modules/
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createRequire } from "module";
import fs from "fs";

// ── Credentials ──────────────────────────────────────────────────────────────

const ENV_PATH = "/Users/vale/.openclaw/workspace/google-ads/.env";

function loadEnv(filePath) {
  const out = {};
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.+)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = loadEnv(ENV_PATH);

// ── Google Ads client ────────────────────────────────────────────────────────

// Load google-ads-api from its installed location (CJS package)
const require = createRequire("/Users/vale/.openclaw/workspace/google-ads/");
const { GoogleAdsApi, enums } = require("google-ads-api");

const CUSTOMER_ID = "3357756972"; // hard-coded — never overrideable by caller
const MAX_NEGATIVES_PER_CALL = 200;

function makeCustomer() {
  const api = new GoogleAdsApi({
    client_id:       env.GOOGLE_ADS_CLIENT_ID,
    client_secret:   env.GOOGLE_ADS_CLIENT_SECRET,
    developer_token: env.GOOGLE_ADS_DEVELOPER_TOKEN,
  });
  return api.Customer({
    customer_id:       CUSTOMER_ID,
    login_customer_id: CUSTOMER_ID,
    refresh_token:     env.GOOGLE_ADS_REFRESH_TOKEN,
  });
}

function microsToDollars(micros) {
  return Math.round(Number(micros || 0) / 10000) / 100;
}

function adelaideToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Adelaide" }).format(new Date());
}

function normalizeCampaignId(value) {
  const id = String(value ?? "").trim();
  if (!/^\d+$/.test(id)) throw new Error("campaign_id must contain digits only");
  return id;
}

function normalizeNegatives(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("negatives must be a non-empty array");
  }
  if (value.length > MAX_NEGATIVES_PER_CALL) {
    throw new Error(`A maximum of ${MAX_NEGATIVES_PER_CALL} negatives can be added per call`);
  }

  const allowedMatchTypes = new Set(["EXACT", "PHRASE", "BROAD"]);
  const seen = new Set();
  const normalized = [];
  for (const item of value) {
    const text = String(item?.text ?? "").trim().replace(/\s+/g, " ");
    const match_type = String(item?.match_type ?? "EXACT").trim().toUpperCase();
    if (!text || text.length > 80) throw new Error("Each negative keyword must be 1-80 characters");
    if (!allowedMatchTypes.has(match_type)) {
      throw new Error(`Unsupported match_type for \"${text}\": ${match_type}`);
    }
    const key = `${match_type}\u0000${text.toLocaleLowerCase("en-AU")}`;
    if (!seen.has(key)) {
      seen.add(key);
      normalized.push({ text, match_type });
    }
  }
  return normalized;
}

function keywordKey(text, matchType) {
  return `${String(matchType).toUpperCase()}\u0000${String(text).trim().toLocaleLowerCase("en-AU")}`;
}

function googleAdsErrorPayload(error) {
  const apiError = error?.response?.data?.error;
  const candidates = [
    ...(Array.isArray(error?.errors) ? error.errors : []),
    ...(Array.isArray(error?.failure?.errors) ? error.failure.errors : []),
    ...(Array.isArray(apiError?.details)
      ? apiError.details.flatMap((detail) => Array.isArray(detail?.errors) ? detail.errors : [])
      : []),
  ];
  const details = candidates.slice(0, 8).map((item) => ({
    message: typeof item?.message === "string" ? item.message : undefined,
    error_code: item?.error_code ?? item?.errorCode ?? undefined,
    trigger: item?.trigger ?? undefined,
    location: item?.location ?? undefined,
  })).filter((item) => Object.values(item).some((value) => value !== undefined));
  const directMessage = typeof error?.message === "string" && error.message !== "[object Object]"
    ? error.message
    : null;
  const detailMessage = details.find((item) => item.message)?.message;
  return {
    error: directMessage || detailMessage || (typeof apiError?.message === "string" ? apiError.message : "Google Ads API request failed"),
    status: apiError?.status ?? error?.status ?? undefined,
    code: apiError?.code ?? error?.code ?? undefined,
    request_id: error?.request_id ?? error?.requestId ?? undefined,
    details: details.length ? details : undefined,
  };
}

// ── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "gads", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

// ── Tool definitions ─────────────────────────────────────────────────────────

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "gads_campaign_performance",
      description:
        "Query Google Ads campaign performance for RESLU (customer 3357756972). " +
        "Returns impressions, clicks, CTR, spend (AUD), and conversions per enabled campaign " +
        "for the given date range. Use for spend reviews, weekly reports, and performance checks. " +
        "Read-only — no mutations possible.",
      inputSchema: {
        type: "object",
        required: ["start_date", "end_date"],
        properties: {
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date:   { type: "string", description: "End date YYYY-MM-DD" },
        },
      },
    },
    {
      name: "gads_search_terms",
      description:
        "Query the Google Ads search terms report for RESLU. " +
        "Returns actual user search queries that triggered ads, with clicks and spend per term. " +
        "Use to review keyword quality, identify wasted spend, or understand what a specific lead searched. " +
        "Read-only — no mutations possible.",
      inputSchema: {
        type: "object",
        required: ["start_date", "end_date"],
        properties: {
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date:   { type: "string", description: "End date YYYY-MM-DD" },
          limit: { type: "number", description: "Max rows to return (default 100)" },
        },
      },
    },
    {
      name: "gads_click_view",
      description:
        "Query click-level data for a single day. Returns each click's GCLID, campaign, " +
        "ad group, and keyword. Use this to trace which campaign and keyword triggered " +
        "a specific lead's GCLID. Click View data is available for up to 90 days. " +
        "Read-only — no mutations possible.",
      inputSchema: {
        type: "object",
        required: ["date"],
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (single day only)" },
        },
      },
    },
    {
      name: "gads_budget_status",
      description:
        "Get today's budget and spend status for all active RESLU campaigns. " +
        "Returns daily budget, spend so far today, clicks and impressions. " +
        "Defaults to today in Adelaide time. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date YYYY-MM-DD (defaults to today Adelaide time)" },
        },
      },
    },
    {
      name: "gads_add_campaign_negative_keywords",
      description:
        "Add approved negative keywords to one existing RESLU Google Ads campaign. " +
        "Use only after Phillip explicitly approves the exact keyword list, match types, and target campaign. " +
        "The operation is atomic, skips existing identical negatives, and re-reads Google Ads to verify live state. " +
        "Set validate_only=true to check an operation without changing the account. This tool cannot alter bids, " +
        "budgets, ads, targeting, campaign status, AI Max, or any other setting.",
      inputSchema: {
        type: "object",
        required: ["campaign_id", "negatives", "approval_reference"],
        additionalProperties: false,
        properties: {
          campaign_id: {
            type: "string",
            pattern: "^[0-9]+$",
            description: "Exact Google Ads campaign ID from a current read result",
          },
          negatives: {
            type: "array",
            minItems: 1,
            maxItems: MAX_NEGATIVES_PER_CALL,
            items: {
              type: "object",
              required: ["text", "match_type"],
              additionalProperties: false,
              properties: {
                text: { type: "string", minLength: 1, maxLength: 80 },
                match_type: { type: "string", enum: ["EXACT", "PHRASE", "BROAD"] },
              },
            },
          },
          approval_reference: {
            type: "string",
            minLength: 1,
            maxLength: 500,
            description: "Short quote or conversation reference containing Phillip's exact approval",
          },
          validate_only: {
            type: "boolean",
            default: false,
            description: "Validate with Google Ads without making a live change",
          },
        },
      },
    },
    {
      name: "gads_query",
      description:
        "Run an arbitrary Google Ads Query Language (GAQL) query against the RESLU Google Ads account. " +
        "Use this when the purpose-built reporting tools do not expose the fields or resources needed. " +
        "The customer account is fixed by the connector and cannot be overridden by the caller.",
      inputSchema: {
        type: "object",
        required: ["query"],
        additionalProperties: false,
        properties: {
          query: { type: "string", minLength: 1, description: "Complete GAQL SELECT query" },
        },
      },
    },
    {
      name: "gads_mutate_resources",
      description:
        "Create, update, or remove arbitrary supported Google Ads resources in the RESLU account. " +
        "This is Marco's full write-capability tool for campaigns, budgets, ad groups, criteria, keywords, " +
        "ads, assets, audiences, conversions, shared sets, and other resources supported by google-ads-api. " +
        "The account is fixed by the connector. Use validate_only when testing and query authoritative state " +
        "after live mutations to verify the requested outcome.",
      inputSchema: {
        type: "object",
        required: ["operations"],
        additionalProperties: false,
        properties: {
          operations: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              required: ["entity", "operation", "resource"],
              additionalProperties: false,
              properties: {
                entity: {
                  type: "string",
                  minLength: 1,
                  description: "google-ads-api entity name, for example campaign, campaign_budget, ad_group, campaign_criterion, or ad_group_ad",
                },
                operation: { type: "string", enum: ["create", "update", "remove"] },
                resource: {
                  description: "Resource object for create/update, or resource-name string for remove",
                  oneOf: [
                    { type: "object", additionalProperties: true },
                    { type: "string", minLength: 1 },
                  ],
                },
                exempt_policy_violation_keys: {
                  type: "array",
                  items: { type: "object", additionalProperties: true },
                  description: "Optional Google Ads policy exemption keys supported for create operations",
                },
              },
            },
          },
          validate_only: { type: "boolean", default: false },
          partial_failure: { type: "boolean", default: false },
          response_content_type: {
            type: "string",
            enum: ["MUTABLE_RESOURCE", "RESOURCE_NAME_ONLY"],
          },
          change_reference: {
            type: "string",
            description: "Optional human-readable request, approval, ticket, or conversation reference for the receipt",
          },
        },
      },
    },
  ],
}));

// ── Tool handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    const customer = makeCustomer();

    if (name === "gads_campaign_performance") {
      const { start_date, end_date } = args;
      const rows = await customer.query(`
        SELECT
          campaign.id,
          campaign.name,
          metrics.impressions,
          metrics.clicks,
          metrics.ctr,
          metrics.cost_micros,
          metrics.conversions,
          metrics.average_cpc
        FROM campaign
        WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
          AND campaign.status = 'ENABLED'
        ORDER BY metrics.cost_micros DESC
      `);

      const campaigns = rows.map((r) => ({
        id:           String(r.campaign?.id ?? ""),
        name:         r.campaign?.name ?? "",
        impressions:  Number(r.metrics?.impressions ?? 0),
        clicks:       Number(r.metrics?.clicks ?? 0),
        ctr_pct:      Math.round(Number(r.metrics?.ctr ?? 0) * 10000) / 100,
        spend_aud:    microsToDollars(r.metrics?.cost_micros),
        conversions:  Number(r.metrics?.conversions ?? 0),
        avg_cpc_aud:  microsToDollars(r.metrics?.average_cpc),
      }));

      const totals = campaigns.reduce(
        (a, c) => ({
          impressions: a.impressions + c.impressions,
          clicks:      a.clicks + c.clicks,
          spend_aud:   Math.round((a.spend_aud + c.spend_aud) * 100) / 100,
          conversions: a.conversions + c.conversions,
        }),
        { impressions: 0, clicks: 0, spend_aud: 0, conversions: 0 }
      );

      return {
        content: [{ type: "text", text: JSON.stringify({ period: { start_date, end_date }, totals, campaigns }, null, 2) }],
      };
    }

    if (name === "gads_search_terms") {
      const { start_date, end_date, limit = 100 } = args;
      const rows = await customer.query(`
        SELECT
          search_term_view.search_term,
          search_term_view.status,
          campaign.name,
          ad_group.name,
          metrics.impressions,
          metrics.clicks,
          metrics.cost_micros,
          metrics.conversions
        FROM search_term_view
        WHERE segments.date BETWEEN '${start_date}' AND '${end_date}'
        ORDER BY metrics.cost_micros DESC
        LIMIT ${Number(limit)}
      `);

      const terms = rows.map((r) => ({
        term:        r.search_term_view?.search_term ?? "",
        status:      r.search_term_view?.status ?? "",
        campaign:    r.campaign?.name ?? "",
        ad_group:    r.ad_group?.name ?? "",
        impressions: Number(r.metrics?.impressions ?? 0),
        clicks:      Number(r.metrics?.clicks ?? 0),
        spend_aud:   microsToDollars(r.metrics?.cost_micros),
        conversions: Number(r.metrics?.conversions ?? 0),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ period: { start_date, end_date }, total_terms: terms.length, terms }, null, 2) }],
      };
    }

    if (name === "gads_click_view") {
      const { date } = args;
      const rows = await customer.query(`
        SELECT
          click_view.gclid,
          campaign.name,
          campaign.id,
          ad_group.name,
          segments.keyword.info.text,
          segments.device,
          segments.date
        FROM click_view
        WHERE segments.date = '${date}'
      `);

      const clicks = rows.map((r) => ({
        gclid:       r.click_view?.gclid ?? "",
        date:        r.segments?.date ?? date,
        campaign:    r.campaign?.name ?? "",
        campaign_id: String(r.campaign?.id ?? ""),
        ad_group:    r.ad_group?.name ?? "",
        keyword:     r.segments?.keyword?.info?.text ?? null,
        device:      r.segments?.device ?? "",
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ date, total_clicks: clicks.length, clicks }, null, 2) }],
      };
    }

    if (name === "gads_budget_status") {
      const date = args.date ?? adelaideToday();
      const rows = await customer.query(`
        SELECT
          campaign.name,
          campaign_budget.amount_micros,
          metrics.cost_micros,
          metrics.impressions,
          metrics.clicks
        FROM campaign
        WHERE segments.date = '${date}'
          AND campaign.status = 'ENABLED'
        ORDER BY metrics.cost_micros DESC
      `);

      const campaigns = rows.map((r) => ({
        name:         r.campaign?.name ?? "",
        daily_budget: microsToDollars(r.campaign_budget?.amount_micros),
        spend_today:  microsToDollars(r.metrics?.cost_micros),
        impressions:  Number(r.metrics?.impressions ?? 0),
        clicks:       Number(r.metrics?.clicks ?? 0),
      }));

      return {
        content: [{ type: "text", text: JSON.stringify({ date, campaigns }, null, 2) }],
      };
    }

    if (name === "gads_add_campaign_negative_keywords") {
      const campaignId = normalizeCampaignId(args.campaign_id);
      const negatives = normalizeNegatives(args.negatives);
      const approvalReference = String(args.approval_reference ?? "").trim();
      const validateOnly = args.validate_only === true;
      if (!approvalReference) throw new Error("approval_reference is required");

      const campaignRows = await customer.query(`
        SELECT campaign.id, campaign.name, campaign.status
        FROM campaign
        WHERE campaign.id = ${campaignId}
        LIMIT 1
      `);
      if (campaignRows.length !== 1) throw new Error(`Campaign ${campaignId} was not found`);
      const campaign = {
        id: String(campaignRows[0].campaign?.id ?? campaignId),
        name: campaignRows[0].campaign?.name ?? "",
        status: campaignRows[0].campaign?.status ?? "",
      };

      const existingRows = await customer.query(`
        SELECT
          campaign_criterion.keyword.text,
          campaign_criterion.keyword.match_type
        FROM campaign_criterion
        WHERE campaign.id = ${campaignId}
          AND campaign_criterion.negative = TRUE
          AND campaign_criterion.type = 'KEYWORD'
      `);
      const existing = new Set(existingRows.map((row) => keywordKey(
        row.campaign_criterion?.keyword?.text,
        row.campaign_criterion?.keyword?.match_type,
      )));
      const skipped = negatives.filter((item) => existing.has(keywordKey(item.text, item.match_type)));
      const additions = negatives.filter((item) => !existing.has(keywordKey(item.text, item.match_type)));

      if (additions.length > 0) {
        const campaignResourceName = `customers/${CUSTOMER_ID}/campaigns/${campaignId}`;
        const operations = additions.map((item) => ({
          entity: "campaign_criterion",
          operation: "create",
          resource: {
            campaign: campaignResourceName,
            negative: true,
            type: enums.CriterionType.KEYWORD,
            keyword: {
              text: item.text,
              match_type: enums.KeywordMatchType[item.match_type],
            },
          },
        }));
        await customer.mutateResources(operations, {
          validate_only: validateOnly,
          partial_failure: false,
        });
      }

      let verified = [];
      if (!validateOnly && additions.length > 0) {
        const verifiedRows = await customer.query(`
          SELECT
            campaign_criterion.keyword.text,
            campaign_criterion.keyword.match_type
          FROM campaign_criterion
          WHERE campaign.id = ${campaignId}
            AND campaign_criterion.negative = TRUE
            AND campaign_criterion.type = 'KEYWORD'
        `);
        const live = new Set(verifiedRows.map((row) => keywordKey(
          row.campaign_criterion?.keyword?.text,
          row.campaign_criterion?.keyword?.match_type,
        )));
        verified = additions.filter((item) => live.has(keywordKey(item.text, item.match_type)));
        if (verified.length !== additions.length) {
          throw new Error(`Google Ads accepted the request but only ${verified.length}/${additions.length} additions were verified live`);
        }
      }

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: validateOnly ? "validated" : "verified",
            customer_id: CUSTOMER_ID,
            campaign,
            approval_reference: approvalReference,
            requested_count: negatives.length,
            added_count: validateOnly ? 0 : verified.length,
            validated_count: validateOnly ? additions.length : 0,
            skipped_existing_count: skipped.length,
            added: validateOnly ? [] : verified,
            validated: validateOnly ? additions : [],
            skipped_existing: skipped,
          }, null, 2),
        }],
      };
    }

    if (name === "gads_query") {
      const query = String(args.query ?? "").trim();
      if (!query) throw new Error("query is required");
      const rows = await customer.query(query);
      return {
        content: [{ type: "text", text: JSON.stringify({ row_count: rows.length, rows }, null, 2) }],
      };
    }

    if (name === "gads_mutate_resources") {
      if (!Array.isArray(args.operations) || args.operations.length === 0) {
        throw new Error("operations must be a non-empty array");
      }
      const allowedOperations = new Set(["create", "update", "remove"]);
      const operations = args.operations.map((item, index) => {
        const entity = String(item?.entity ?? "").trim();
        const operation = String(item?.operation ?? "").trim().toLowerCase();
        const resource = item?.resource;
        if (!entity) throw new Error(`operations[${index}].entity is required`);
        if (!allowedOperations.has(operation)) {
          throw new Error(`operations[${index}].operation must be create, update, or remove`);
        }
        const validObject = resource && typeof resource === "object" && !Array.isArray(resource);
        const validRemoveName = operation === "remove" && typeof resource === "string" && resource.trim();
        if (!validObject && !validRemoveName) {
          throw new Error(`operations[${index}].resource must be an object, or a resource-name string for remove`);
        }
        const normalized = { entity, operation, resource };
        if (Array.isArray(item.exempt_policy_violation_keys)) {
          normalized.exempt_policy_violation_keys = item.exempt_policy_violation_keys;
        }
        return normalized;
      });
      const mutateOptions = {
        validate_only: args.validate_only === true,
        partial_failure: args.partial_failure === true,
      };
      if (args.response_content_type) {
        mutateOptions.response_content_type = args.response_content_type;
      }
      const response = await customer.mutateResources(operations, mutateOptions);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: mutateOptions.validate_only ? "validated" : "accepted",
            customer_id: CUSTOMER_ID,
            operation_count: operations.length,
            change_reference: args.change_reference ?? null,
            response,
            verification_required: !mutateOptions.validate_only,
          }, null, 2),
        }],
      };
    }

    throw new Error(`Unknown tool: ${name}`);

  } catch (err) {
    return {
      content: [{ type: "text", text: JSON.stringify(googleAdsErrorPayload(err), null, 2) }],
      isError: true,
    };
  }
});

// ── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
