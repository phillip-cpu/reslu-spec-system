# RESLU Second Brain — Build Brief v2

**For:** Claude Code (Sonnet recommended for all steps)
**Written by:** Claude Fable 5, incorporating Aria's original brief (7 Jul 2026) + research amendments
**How to use:** Run ONE step per Claude Code session. Paste the Global Conventions section plus that step's section only. Do not start a step until the previous step's acceptance criteria pass.

---

## Architecture summary

Aria (OpenClaw agent, Mac mini, Ollama installed) talks to the RESLU spec system (Supabase + Vercel) via MCP. Three subsystems:

1. **aria_queue** — spec system events land in a table; Aria picks them up. Idle polling costs zero tokens: a script checks the table and only wakes the LLM when rows exist.
2. **workspace_index** — every project/lead/item/diary/SOW entry embedded (OpenAI `text-embedding-3-small`, 1536 dims — the API and indexer run on Vercel, which cannot reach local Ollama, and query/index embeddings must come from the same model) with hybrid vector + full-text search.
3. **Context snapshot** — `GET /api/me/context` returns compact project state in one call, replacing 6–8 MCP round-trips.
4. **Email comb** (new, biggest subsystem) — every inbound email: strip → triage (Haiku) → schema extraction (Sonnet) → match to job/items → diff against stored prices/lead times → write proposal → Phillip approves. Nothing writes to live data without approval. Every extracted value passes a deterministic string-match verification gate.

### Topology (corrected after Step 2 — the original "MCP + API run on Vercel" assumption was wrong; this is what's actually true)

The MCP server runs on Aria's Mac mini as a **thin proxy only** — it holds zero business logic. All logic lives in Vercel API routes; every new MCP tool = one new API route + a dumb proxy passthrough (`apiFetch()` in `mcp/src/index.mjs` — see that file's own header comment). Atomic multi-row operations (e.g. "claim the oldest N unlocked queue rows") use a Postgres function, called via `supabase.rpc(...)` from the API route — the plain PostgREST/supabase-js query builder has no `LIMIT` on `UPDATE` and can't express `SELECT ... FOR UPDATE SKIP LOCKED ... LIMIT n` at all, so this is a real gap, not a style preference. Embeddings remain OpenAI `text-embedding-3-small` from Vercel — the indexer is a Vercel cron, and query/index embeddings must share that one model.

### Division of labor (fixed — do not change)
- **Mac mini (free, deterministic):** mail fetch, talon strip, pdftotext/ocrmypdf, regex first pass, queue heartbeat script, and the MCP server itself (thin proxy — see Topology above).
- **Vercel:** ALL business logic — API routes (including every MCP tool's real implementation), the indexer cron, embeddings via OpenAI.
- **Ollama local LLM:** enum-constrained classification ONLY. It never generates a value (price, date, lead time). It picks labels from a fixed list via structured output grammar. If a task needs a generated value, it is not an Ollama task.
- **Claude API (paid):** schema extraction on actionable mail only, vision on scanned PDFs only, match adjudication, anything needing judgment.
- **Scripts (no model):** queue polling, verification gate, diffing, dedupe.

---

## Global conventions (paste into every session)

- Stack: Supabase (Postgres + pgvector), Vercel (Next.js API routes), existing MCP server in this repo. Adapt naming to existing migration tooling and schema — `projects`, `leads`, `items`, `diary_entries`, `sow_entries` tables already exist; inspect them before writing FKs.
- **Topology (corrected after Step 2):** the MCP server runs on Aria's Mac mini as a thin proxy only — zero business logic there. Every new MCP tool = a new Vercel API route holding the real logic + a dumb `apiFetch()` passthrough in `mcp/src/index.mjs`. Never implement tool logic directly in the MCP server file.
- Atomic multi-row operations (claim-N-oldest-unlocked-rows, anything needing `FOR UPDATE SKIP LOCKED` or a `LIMIT` on a write) need a Postgres function called via `supabase.rpc(...)` — the query builder has no `LIMIT` on `UPDATE` and can't express `SELECT ... FOR UPDATE SKIP LOCKED ... LIMIT n`. Don't try to approximate this with plain `UPDATE ... WHERE ...`; it won't give the same concurrency guarantee.
- Every MCP tool returns concise, high-signal output: names + IDs + one-line summaries, never full records. Support `response_format: 'concise' | 'detailed'`, default concise. Paginate anything unbounded. Error messages must tell the agent how to fix the call.
- All timestamps `timestamptz`, all IDs `uuid default gen_random_uuid()`.
- Env vars available: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (embeddings only). Ollama at `http://localhost:11434` (Mac mini scripts only — never reachable from Vercel).
- Write a migration file per step; never edit a previous migration.
- Each step ends with: run the acceptance checks, show output, stop. Do not continue into the next step.

---

## Step 0 — Prerequisites (manual, no Claude Code needed)

- Supabase dashboard → Database → Extensions → enable `vector`.
- Mac mini: `ollama pull llama3.2` (or current small model) if using optional local pre-triage.
- Confirm `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` (embeddings only) in Vercel env vars.

---

## Step 1 — `aria_queue` table

```sql
create type aria_queue_kind as enum
  ('price_request','trade_reminder','lead_flag','approval_needed','email_proposal');
create type aria_queue_status as enum ('pending','picked_up','done','failed');

create table aria_queue (
  id uuid primary key default gen_random_uuid(),
  kind aria_queue_kind not null,
  status aria_queue_status not null default 'pending',
  payload jsonb not null default '{}',
  dedupe_key text unique,
  source text,
  created_at timestamptz not null default now(),
  picked_up_at timestamptz,
  resolved_at timestamptz,
  attempts int not null default 0,
  error text
);
create index aria_queue_pending_idx on aria_queue (status, created_at);
```

- `dedupe_key`: business key like `price_request:{item_id}:{yyyy-mm}` — inserts use `on conflict (dedupe_key) do nothing`. Delivery is at-least-once; handlers must be idempotent.
- Rows are never deleted — resolved rows are the audit trail.

**Accept:** migration applies clean; inserting a duplicate dedupe_key is a silent no-op; `select * from aria_queue where status='pending' order by created_at` uses the index (`explain`).

## Step 2 — Queue MCP tools

```
get_aria_queue(limit: int = 10) ->
  [{ id, kind, payload, created_at }]
  // atomically: update status='picked_up', picked_up_at=now(), attempts=attempts+1
  // WHERE status='pending' OR (status='picked_up' AND picked_up_at < now() - interval '15 minutes')
  // order by created_at asc limit $limit, using FOR UPDATE SKIP LOCKED

resolve_queue_item(id: uuid, status: 'done'|'failed', note?: string) -> { ok: true }
```

- The 15-minute re-expose is the visibility timeout: if Aria crashes mid-item, it comes back.
- Empty queue returns `[]` — Aria's heartbeat script checks row count BEFORE invoking any model. Zero rows = zero tokens.

**Accept:** two concurrent `get_aria_queue` calls never return the same row (test with two parallel calls); a picked_up row older than 15 min is returned again; resolve sets `resolved_at`.

## Step 3 — Wire existing events to the queue

Find the three existing event sites in this repo and add queue inserts:
- price request raised → `kind='price_request'`, payload `{item_id, project_id, supplier}`, dedupe `price_request:{item_id}:{iso_week}`
- trade reminder due → `kind='trade_reminder'`, payload `{project_id, trade, due_date}`, dedupe `trade_reminder:{project_id}:{trade}:{due_date}`
- lead overdue → `kind='lead_flag'`, payload `{lead_id, days_overdue}`, dedupe `lead_flag:{lead_id}:{iso_week}`

**Accept:** trigger each event in dev; row appears once; re-triggering same event same week does not duplicate.

## Step 4 — `workspace_index` table

```sql
create table workspace_index (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in
    ('project','lead','item','diary','sow','email','skill','memory')),
  entity_id uuid not null,
  title text not null,
  content text not null,
  content_hash text not null,
  metadata jsonb not null default '{}',
  fts tsvector generated always as
    (to_tsvector('english', title || ' ' || content)) stored,
  embedding vector(1536),
  updated_at timestamptz not null default now(),
  unique (entity_type, entity_id)
);
create index workspace_index_hnsw on workspace_index
  using hnsw (embedding vector_cosine_ops);
create index workspace_index_fts on workspace_index using gin (fts);
create index workspace_index_type on workspace_index (entity_type);
```

- 1536 dims = text-embedding-3-small. One row per record, no chunking — `content` is a composed string of the record's key fields (write a `content_for(entity)` function per entity type: name + address + stage + key items for a project; product + supplier + price + lead time for an item; etc.).
- `content_hash` = sha256 of content. Re-embed only when hash changes.

**Accept:** migration applies; upsert on `(entity_type, entity_id)` works; HNSW index exists (`\di`).

## Step 5 — Indexer (Vercel cron, daily 02:00, plus manual trigger route)

1. Pull all entities from Supabase (paginated).
2. Compute `content_for(entity)` + hash. Skip unchanged hashes.
3. For changed/new: OpenAI embeddings API, `text-embedding-3-small`, batched up to 100 inputs per request → upsert rows.
4. Delete index rows whose entity no longer exists.
5. Log: counts of embedded / skipped / deleted. Fail loudly on any error.
6. Mind Vercel function timeout: process in pages and self-invoke or chunk if the first full run exceeds the limit.

**Accept:** first run indexes everything; second immediate run embeds 0 (all hashes match); editing one project then running embeds exactly 1.

## Step 6 — `search` MCP tool (hybrid RRF)

SQL function combining vector + full-text via reciprocal rank fusion (Supabase documented pattern — spec data is full of exact codes like product names and AS/NZS refs that embeddings miss):

```sql
-- hybrid_search(query_text text, query_embedding vector(1536),
--   match_count int, filter_type text default null)
-- score = coalesce(1.0/(60+fts_rank),0) + coalesce(1.0/(60+vec_rank),0)
```

Set `hnsw.ef_search` and enable `set hnsw.iterative_scan = relaxed_order;` (pgvector ≥0.8) so `entity_type` filters don't starve results.

```
search(query: string, entity_type?: string, limit: int = 8,
       response_format: 'concise'|'detailed' = 'concise') ->
  [{ id, entity_type, entity_id, title, snippet(<=140 chars), score }]
```

Query embedding: the MCP server runs on Vercel — embed the query inline via OpenAI `text-embedding-3-small` (same model as the index, non-negotiable) before calling `hybrid_search`.

**Accept:** `search('polytec ravine')` returns the item first; `search('AS 1428')` (exact code) returns the right SOW entry (full-text catches it); `entity_type='project'` filter returns ≥5 results not 0–1.

## Step 7 — `GET /api/me/context` snapshot endpoint

One call, compact payload, target < 2,500 tokens serialized:

```json
{
  "projects": [{ "id", "name", "stage", "flags": [], "item_count",
                 "open_proposals", "last_diary": "one line" }],
  "leads": [{ "id", "name", "stage", "days_since_contact" }],
  "pending_queue": { "count", "kinds": {"price_request": 2} },
  "recent_diary": [ "5 one-line entries" ],
  "skills": [ "refs only" ],
  "memory_refs": [ "paths only" ],
  "generated_at": "..."
}
```

Rules: IDs + names + counts + one-liners ONLY. No full records — Aria pulls detail via `search`/existing tools when needed. Add `get_context_snapshot(project_id?)` MCP tool wrapping it; with `project_id` it returns one project expanded (items with current price + lead time, open proposals, recent emails).

**Accept:** full snapshot serializes under 2,500 tokens (measure with a tokenizer, assert in a test); response time < 500ms; single-project mode includes item prices.

## Step 8 — Email ingest + preprocessing (Mac mini)

Tables:

```sql
create table emails (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,
  thread_id text,
  from_addr text not null,
  subject text,
  received_at timestamptz not null,
  raw_ref text,
  clean_text text,
  token_estimate int,
  triage_label text,
  triage_confidence numeric,
  matched_project_id uuid references projects(id),
  match_confidence numeric,
  match_method text,
  status text not null default 'new' check (status in
    ('new','triaged','extracted','matched','proposed','done','review','skipped')),
  processed_at timestamptz
);
create table email_attachments (
  id uuid primary key default gen_random_uuid(),
  email_id uuid not null references emails(id),
  filename text, mime text, storage_ref text,
  extracted_text text, extraction_method text,
  needs_vision boolean not null default false
);
```

Pipeline script (cron every 10 min on Mac mini):
1. Fetch new mail (IMAP/Gmail API — match existing setup). Dedupe on `message_id`.
2. HTML → markdown, then strip quoted replies + signatures with `talon` (Mailgun) or `email_reply_parser`. Store as `clean_text`.
3. PDFs: `pdftotext` first. If empty text layer → `ocrmypdf` → retry. Still nothing → `needs_vision=true` and store page count. Regex-scan extracted text: keep only pages containing `$`, digit+wk/week, or known item names when the doc is >5 pages (store which pages).
4. Hard rules skip: newsletters, auto-replies, noreply senders → `status='skipped'`.

**Accept:** run against 20 real emails: `clean_text` contains no quoted history or signatures; a text-layer PDF quote produces `extracted_text` with prices present; token_estimate for a typical email < 900.

## Step 9 — Triage + extraction

**Triage (Haiku, batched):** cron picks up `status='new'` in batches of up to 20 per call. Cached system prompt (instructions + label definitions ≥1,024 tokens so caching engages, stable prefix FIRST, email batch LAST). Labels: `supplier_quote | price_update | lead_time_update | client_rfi | approval | follow_up | fyi | noise`. Output via strict tool-use: `[{email_id, label, confidence}]`. `fyi`/`noise` → `status='done'`, never extracted.

**Extraction (Sonnet, actionable only):** strict tool-use, one schema:

```json
{
  "job_mentions": [{ "text": "...", "source_quote": "..." }],
  "item_mentions": [{ "text": "...", "source_quote": "..." }],
  "price_facts": [{ "item_text": "...", "value": 136.00, "currency": "AUD",
    "unit": "m2", "gst_inclusive": false, "effective_date": "2026-08-01",
    "source_quote": "exact substring from clean_text or attachment text" }],
  "lead_time_facts": [{ "item_text": "...", "value_weeks": 5,
    "source_quote": "..." }],
  "actions_requested": [{ "description": "...", "source_quote": "..." }],
  "confidence": 0.0
}
```

`source_quote` is MANDATORY on every fact — the verification gate depends on it. Attachments with `needs_vision=true`: send only flagged pages to Claude vision, same schema. Non-urgent backlog (>24h old): route through the Batch API (50% off, stacks with 1-hour cache).

**Accept:** triage batch of 20 emails = 1 API call; cache read tokens > cache write tokens by the second batch (check usage in response); extraction on a seeded price-update email returns the price fact with a verbatim source_quote; an `fyi` email never reaches extraction.

## Step 10 — Entity matching + aliases

```sql
create table entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  alias text not null,
  source text not null default 'human_correction',
  created_at timestamptz default now(),
  unique (entity_type, alias)
);
create extension if not exists pg_trgm;
```

Matching ladder for each job/item mention (stop at first hit):
1. Sender domain → supplier record → that supplier's items only (cheap, high-precision prior).
2. Exact / `entity_aliases` lookup (case-insensitive).
3. `pg_trgm` similarity > 0.55 against names.
4. `workspace_index` embedding similarity, top 5 candidates.
5. If steps 3–4 give candidates but no clear winner: ONE Claude call adjudicates top-5 (returns entity_id or `no_match`).

Confidence bands (combined score): **≥ 0.90 auto-link · 0.60–0.90 → `status='review'` + queue row `kind='approval_needed'` · < 0.60 no link.** Every human correction inserts an `entity_aliases` row so the same variant auto-links next time.

**Accept:** "Bayside" matches Bayside clinic fitout via trigram; an email from a known supplier domain matches through path 1 with no model call; an ambiguous mention lands in review, and after correcting it once the same mention auto-links on re-run.

## Step 11 — Proposals + verification gate + approval

```sql
create table change_proposals (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null, entity_id uuid not null,
  field text not null,
  old_value jsonb, new_value jsonb not null,
  source_email_id uuid not null references emails(id),
  source_quote text not null,
  confidence numeric not null,
  status text not null default 'pending' check (status in
    ('pending','approved','rejected','failed_verification')),
  created_at timestamptz default now(),
  resolved_at timestamptz, resolved_by text, note text
);
```

Flow per extracted fact:
1. Diff against stored value. No change → drop silently.
2. **Verification gate (script, no model):** normalize whitespace; assert `source_quote` appears verbatim in `clean_text` or attachment `extracted_text`; assert the numeric value appears inside the quote. Fail → `status='failed_verification'` + review queue row. This catches hallucinated numbers from ANY model, deterministically.
3. Pass → insert proposal + `aria_queue` row `kind='email_proposal'` with payload `{proposal_id, summary: "Polytec Ravine $128→$136/m² · Bayside clinic · from Laminex email 9:14"}`.
4. Aria surfaces it to Phillip; approve/reject tools:
   - `approve_proposal(id)` → applies the write inside a transaction + audit trigger appends to an append-only `audit_log` table, resolves queue row.
   - `reject_proposal(id, note?)` → resolves, optionally writes alias/correction.
5. Prices and lead times ALWAYS go through proposals — no threshold auto-applies them. Client-facing anything is drafted, never sent.

**Accept:** seeded email with a changed price produces exactly one proposal with correct old/new; same email re-processed produces zero (dedupe on diff); a proposal with a doctored quote fails verification; approving writes the item price and the audit row; unchanged prices produce nothing.

## Step 12 — Remaining tools + polish

- `index_rebuild(entity_type?)` MCP tool → invokes the Step 5 indexer route directly (same Vercel deployment).
- Truncation guard on every MCP tool: cap responses ~2,000 tokens with a message telling the agent how to narrow (filter/paginate).
- Heartbeat script (Mac mini): check `aria_queue` count via cheap REST HEAD/count → zero rows = exit, no model. Rows exist = wake Aria with the batch.
- README section documenting: prompt layout (stable cached prefix → volatile snapshot last), model routing table, verification gate contract.

**Accept:** full end-to-end demo: seeded supplier email → strip → triage → extract → match → proposal → queue → approve → item updated + audit row, with token usage per stage logged.

## Step 13 — Brain visualizer (optional, engineering only — NO design work)

A working reference implementation ships with this brief: `brain-visualizer-reference.html`. It is the approved design. The rendering, palette, motion, typography and layout are FROZEN — do not redesign, restyle, or "improve" them. Scope is strictly:

1. New route `/brain` serving the reference file's markup.
2. Replace the hardcoded `CL` cluster array with live data: counts per `entity_type` from `workspace_index` (`select entity_type, count(*) group by 1`), real cluster names, real record names on the big dots (most recent / flagged records).
3. Aggregation rule (fixed, not a judgment call): render individual dots only for flagged records and records touched in the last 90 days, capped at 1,500 dots total; all remaining records exist only as cluster counts. Never render one dot per record at full scale.
4. Amber ring = record with an open `change_proposals` row. Clicking a named dot opens that record in the spec system (existing detail route).
5. Routine ring nodes read from the real cron definitions; hex ring apps stay hardcoded.
6. Search box filters: matching dots stay full alpha, everything else drops to 0.15.

**Accept:** page renders 60fps with production data; dot count ≤1,500 verified; clicking a flagged item opens its record; search for "polytec" dims everything else. Any visual change beyond the above requires a screenshot-based sign-off from Phillip — do not iterate on aesthetics blind.

---

## Appendix A — Model routing (fixed)

| Task | Runner |
|---|---|
| Fetch, strip, pdf text, regex, diff, verify, poll | script, no model |
| Embeddings (index + queries) | OpenAI text-embedding-3-small, from Vercel |
| Triage labels | Haiku (batch of 20) |
| Extraction, vision on scans, match adjudication | Sonnet |
| Anything the brief says "figure out" | Fable / Opus |

## Appendix B — Session hygiene for whoever builds this

One step per session. Paste Global Conventions + the step. Plan mode before steps 5, 9, 10, 11. `/clear` between steps. If a step exceeds ~2 hours of iteration, stop and split it. Estimated build: 15–30M tokens total; Step 9–11 is half of it.
