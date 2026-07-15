# reslu-spec-mcp

MCP server wrapping the RESLU Spec System's REST API, so Aria (OpenClaw, running on the Mac mini) or any Claude agent can drive the system through native MCP tools instead of raw HTTP.

Per BUILD-SPEC.md ("Agent control — Aria" / "Week 10 — Aria API layer"): every tool here is a thin `fetch()` against a route already documented in `docs/API.md` — there is no business logic in this package. If a tool's behaviour looks wrong, the bug is almost certainly in the API route, not here.

This package is **installed and run on Aria's Mac mini**, not in the main app's sandbox — it has its own `package.json` and is never imported by the Next.js app. It was written without the ability to `npm install` or execute it in this environment; correctness comes from careful reading against the `@modelcontextprotocol/sdk` 1.x API, not from a test run. Verify with a real `npm install && node src/index.mjs` on the mini before trusting it in production.

## Install

```bash
cd mcp
npm install
```

This installs `@modelcontextprotocol/sdk` and `@supabase/supabase-js` — the only two dependencies. No build step; `src/index.mjs` runs directly under Node (ESM, `"type": "module"` in `package.json`).

Requires Node 18.17+ (for global `fetch`).

## Environment variables

Set these in the shell environment that launches the MCP server (e.g. exported in the mini's `~/.zshrc`, or in whatever launchd plist / process manager starts Aria's automations). There is no `.env` file loaded automatically by this package — keep secrets out of any file that could be committed.

| Variable | Description |
|---|---|
| `SPEC_URL` | Base URL of the deployed Spec System, e.g. `https://spec.reslu.com.au` (no trailing slash). |
| `ARIA_EMAIL` | Aria's Supabase Auth email — `aria@reslu.com.au` (her own account, profile "Aria (agent)", role `admin` — see BUILD-SPEC.md §"Agent control — Aria"). |
| `ARIA_PASSWORD` | Aria's Supabase Auth password. |
| `NEXT_PUBLIC_SUPABASE_URL` | The same Supabase project URL the main app uses (Dashboard → Settings → API). Needed here because this server signs in with supabase-js directly, the same way the main app's browser client would. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The Supabase anon key (not the service role key — this is a normal user sign-in, not a privileged service-role client). |

None of these are the app's `.env.local` file — copy the relevant values across by hand. Never commit real values.

## How auth works

1. On first tool call, the server calls `supabase.auth.signInWithPassword({ email: ARIA_EMAIL, password: ARIA_PASSWORD })` and caches the resulting access token in memory.
2. Every tool call sends that token as `Authorization: Bearer <token>` to the REST API.
3. If a request gets back `401`, the cached token is discarded, the server signs in exactly once more, and retries the same request exactly once. If that also fails, the tool call fails with a clear error — there is no retry loop.
4. Every route the tools call independently re-checks Aria's role server-side (leads/invoices routes require `admin`; Aria's profile is admin per BUILD-SPEC.md, revocable by Phillip changing her role in Settings). This package does not — and cannot — bypass that.

## Claude Code / OpenClaw MCP config

Add an entry like this to the MCP config file OpenClaw (or Claude Code) reads on the mini — path and file name depend on the client; consult its own docs for exactly where this snippet goes (e.g. Claude Code's `~/.claude/mcp.json`-style config, or OpenClaw's equivalent):

```json
{
  "mcpServers": {
    "reslu-spec": {
      "command": "node",
      "args": ["/absolute/path/to/reslu-spec-system/mcp/src/index.mjs"],
      "env": {
        "SPEC_URL": "https://spec.reslu.com.au",
        "ARIA_EMAIL": "aria@reslu.com.au",
        "ARIA_PASSWORD": "REPLACE_ME",
        "NEXT_PUBLIC_SUPABASE_URL": "https://your-project-ref.supabase.co",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": "REPLACE_ME"
      }
    }
  }
}
```

Use an **absolute path** to `mcp/src/index.mjs` on the mini (per BUILD-SPEC.md's migration note: clone the repo to a normal local folder there, never iCloud Drive). Restart the MCP client after editing this config.

## Tool list

Every tool is a thin wrapper over an existing REST route — see `docs/API.md` for full request/response detail on each.

| Tool | REST route | Notes |
|---|---|---|
| `list_projects` | `GET /api/projects` | All active projects. |
| `get_project` | `GET /api/projects/[id]` | Full project detail. |
| `get_project_health` | `GET /api/projects/data-quality` or `GET /api/projects/[id]/data-quality` | Admin-only, read-only Project Health feed. Company scans are concise and paginated to avoid truncation; follow `next_offset` until complete. Phase 4 corrections remain human-approved. |
| `list_items` | `GET /api/projects/[id]/items` | Spec register — design data only, no pricing. |
| `create_item` | `POST /api/projects/[id]/items` | `item_code` is generated server-side; never pass one. |
| `update_item_status` | `PATCH /api/items/[id]` | Status only (`Specced`/`Quoted`/`Ordered`/`On Site`/`Installed`); triggers the existing one-way Monday sync on a move to `Ordered`, same as the UI. |
| `list_leads` | `GET /api/leads` | Admin-only. Filters: `stage`, `q`, `since`. |
| `move_lead_stage` | `POST /api/leads/[id]/stage` | Writes a `lead_stage_events` row (DB trigger); returns the updated lead + its history. |
| `get_needs_attention` | `GET /api/leads/attention` | The four needs-attention groups — poll this for the lead-monitor/nurturer automations. |
| `list_invoices` | `GET /api/projects/[id]/invoices` | Admin-only, financial. Filter: `status`. |
| `create_invoice` | `POST /api/projects/[id]/invoices` | Admin-only, financial. Use after parsing a supplier invoice email/PDF. |
| `propose_supplier_invoice` | `POST /api/projects/[id]/invoices` | Creates an Aria-sourced draft only. A human still approves/applies it in the Invoice queue. |
| `submit_followup_draft` | `POST /api/aria-followups` | Saves exact lead follow-up copy to the Office approval inbox; cannot send or change the lead. |
| `complete_followup_send` | `POST /api/aria-followups/[id]/complete` | Records sent/failed only after an explicit Office approval created the approved queue item. |
| `post_client_update` | `POST /api/projects/[id]/client-updates/posts` | Creates a **draft** — does not publish to the client portal. |
| `draft_diary_entry` | `GET`/`POST /api/projects/[id]/client-updates/posts/[postId]/aria-draft` | Two modes: call without `title`/`body_richtext` to FETCH a draft's rough notes + photo captions; call WITH both to SUBMIT polished copy (sets `status: 'pending_approval'`). Never publishes — see `docs/ARIA.md`'s "Diary workflow" section. |
| `list_site_photos` | `GET /api/projects/[id]/site-photos` | The project's internal gallery (published + unpublished), for referencing captions/photos when drafting a diary entry. Read-only. |
| `list_contacts` | `GET /api/contacts` | Address Book (trades/suppliers). Filters: `q`, `category`. |
| `create_board_task` | `POST /api/projects/[id]/board` | Needs an existing `column_id` for that project. |

## Rate guidance

There is no rate limiting implemented in this package itself (the REST API's own rate limiting, where present, is the real backstop — see `lib/rate-limit.ts` in the main app). As a courtesy:

- `get_needs_attention` and `list_leads?since=` are cheap, designed to be polled every few minutes by the lead-monitor/nurturer automations — no special throttling needed.
- Avoid polling `list_projects`/`list_items` in a tight loop; they are not designed as a change-feed. Prefer `list_leads?since=<ISO timestamp>` for "what's new" checks over re-fetching everything.
- Every `create_*`/`move_*`/`update_*`/`post_*` tool is a real write — there is no dry-run mode in this MCP layer (unlike `scripts/import-monday-leads.mjs`, which defaults to a dry run). Be deliberate.

## What stays Aria-side (not exposed as tools)

Per BUILD-SPEC.md's "Site Visit Booked stage" note: booking calendar entries, confirmation email drafts, and WhatsApp alerts remain entirely Aria's own responsibility via her existing Google Calendar / Gmail / WhatsApp access on the mini — none of that is proxied through this MCP server or the Spec System API. This server only ever reads/writes Spec System data; it has no knowledge of Aria's calendar, email, or messaging tools.

## Troubleshooting

- **"Missing required environment variables"** on startup — check the table above; the server refuses to start rather than fail confusingly on first tool call.
- **Every tool call fails with a 401-ish error even after retry** — `ARIA_PASSWORD` is likely wrong, or Aria's Supabase user was disabled/deleted. Verify by signing in as `aria@reslu.com.au` directly via Supabase Auth (e.g. the Supabase dashboard's "Impersonate user" or a quick manual `signInWithPassword` check).
- **A leads/invoices tool returns 403** — Aria's `profiles.role` has been changed away from `admin` (Phillip can revoke this at any time in Settings, per BUILD-SPEC.md). This is enforced server-side and cannot be worked around from this package.
