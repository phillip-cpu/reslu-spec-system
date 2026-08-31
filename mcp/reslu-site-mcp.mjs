#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_SITE_ROOT,
  applySitePatch,
  captureLiveTagRequests,
  deploySiteFiles,
  liveTrackingSurface,
  readSiteFile,
  replaceSiteText,
  runSiteChecks,
  siteDiff,
  siteStatus,
} from "./reslu-site-core.mjs";

const SITE_ROOT = process.env.RESLU_SITE_ROOT || DEFAULT_SITE_ROOT;
const server = new Server({ name: "reslu-site", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "site_status",
      description: "Inspect the RESLU Astro repository, Git state, and source-level Google/Meta tracking configuration. Use this before editing or deploying.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "site_live_tracking_surface",
      description: "Inspect the deployed reslu.com.au HTML for the Google tag loader, Ads account ID, and GA4 loader. This checks deployment surface, not event emission; use browser network requests during a controlled submission for emission proof.",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
    },
    {
      name: "site_capture_live_tag_requests",
      description: "Use RESLU's managed Chrome to inspect live tracking. Default mode returns filtered page-load requests. For safe submit-handler proof, set controlledSubmission=true and confirm=true on a /begin URL; it drives the real form UI while intercepting the enquiry response and suppressing Google/Meta transmission, so no fake lead, email, or platform conversion is created.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          controlledSubmission: { type: "boolean", default: false },
          confirm: { type: "boolean", default: false },
        },
      },
    },
    {
      name: "site_read_file",
      description: "Read a text source file inside /Users/vale/reslu-site. Secret env files, .git, build output, and node_modules are blocked.",
      inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
    },
    {
      name: "site_diff",
      description: "Show the current unstaged Git diff for all files or an explicit list of repository-relative paths.",
      inputSchema: { type: "object", properties: { paths: { type: "array", items: { type: "string" } } } },
    },
    {
      name: "site_apply_patch",
      description: "Make a focused source edit. Prefer path + oldText + newText + expectedOccurrences=1 for exact replacements. Alternatively supply a real unified Git patch with diff --git, --- a/path, +++ b/path, and valid numeric @@ hunk counts. Codex '*** Begin Patch' syntax is not accepted.",
      inputSchema: {
        type: "object",
        properties: {
          patch: { type: "string" },
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          expectedOccurrences: { type: "integer", minimum: 1, default: 1 },
        },
        anyOf: [
          { required: ["patch"] },
          { required: ["path", "oldText", "newText"] },
        ],
      },
    },
    {
      name: "site_run_checks",
      description: "Run the RESLU site test suite and production Astro build. Use after edits and before deployment.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "site_deploy_files",
      description: "Run all checks, commit only explicitly selected changed files, push the current branch, and trigger Vercel auto-deployment. Never stages unrelated files. This changes production; set confirm=true only when the requested work is ready.",
      inputSchema: {
        type: "object",
        required: ["paths", "commitMessage", "confirm"],
        properties: {
          paths: { type: "array", minItems: 1, items: { type: "string" } },
          commitMessage: { type: "string" },
          confirm: { type: "boolean" },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  try {
    let result;
    if (name === "site_status") result = siteStatus(SITE_ROOT);
    else if (name === "site_live_tracking_surface") result = await liveTrackingSurface(args.url);
    else if (name === "site_capture_live_tag_requests") result = captureLiveTagRequests(args.url, args);
    else if (name === "site_read_file") result = readSiteFile(args.path, SITE_ROOT);
    else if (name === "site_diff") result = siteDiff(args.paths || [], SITE_ROOT);
    else if (name === "site_apply_patch") {
      result = typeof args.patch === "string"
        ? applySitePatch(args.patch, SITE_ROOT)
        : replaceSiteText(args, SITE_ROOT);
    }
    else if (name === "site_run_checks") result = runSiteChecks(SITE_ROOT);
    else if (name === "site_deploy_files") result = deploySiteFiles(args, SITE_ROOT);
    else throw new Error(`unknown tool: ${name}`);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: error?.message || String(error) }, null, 2) }] };
  }
});

await server.connect(new StdioServerTransport());
