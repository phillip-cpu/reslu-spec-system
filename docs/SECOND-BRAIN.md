# RESLU Second Brain — how it actually works

Step 12 (docs/RESLU-second-brain-build-brief.md) asks for a README section
documenting prompt layout, model routing, and the verification gate
contract. This is that section, written against what's actually shipped
(Steps 1-11) rather than the brief's original plan — see each step's own
commit messages for the specific corrections made along the way (table
names, topology, threshold tuning, etc.).

## Prompt layout: stable prefix first, volatile last

Every cached call (`lib/second-brain/triage.ts`) puts the STATIC content —
label definitions, worked examples, RESLU's own vocabulary/lifecycle
context — in the system prompt, marked `cache_control: {type: "ephemeral"}`.
The VOLATILE content (the actual batch of emails being triaged) goes last,
in the user message, never in the cached block. This is not optional
ordering — Anthropic's caching matches a prefix; putting anything that
changes between calls before the cache breakpoint means every call misses.

**The real minimum length matters and is model-specific**, discovered the
hard way in Step 9: Claude Haiku 4.5 needs **4,096 tokens** minimum before
`cache_control` does anything at all (not the 1,024 the brief's own text
suggested — that number is correct for Sonnet-class models, not Haiku).
Below the minimum, the API silently skips caching — no error, just
`cache_creation_input_tokens: 0` forever. `lib/second-brain/triage.ts`'s
system prompt is deliberately long (worked examples, RESLU-specific
vocabulary) partly to comfortably clear this bar with real content, not
padding.

Extraction (`lib/second-brain/extraction.ts`) and matching adjudication
(`lib/second-brain/matching.ts`) are NOT cached — each call's content is
already mostly unique per-email/per-mention, so caching wouldn't help the
way it does for triage's shared label-definition prefix repeated across
every batch.

## Model routing (as actually implemented)

| Task | Model / runner | Where |
|---|---|---|
| Fetch mail, strip signatures, pdftotext/ocrmypdf, hard-rule skip | Script, no model | `scripts/email_ingest.py` (Mac mini, Step 8) |
| Queue polling, verification gate, diffing, dedupe | Script, no model | `lib/second-brain/verification-gate.ts`, the propose/match routes' own diff logic (Steps 10-11) |
| Embeddings (workspace_index + search queries) | OpenAI `text-embedding-3-small` | `lib/second-brain/embeddings.ts`, from Vercel (Steps 5-6) |
| Triage labels (batched) | Claude Haiku 4.5 | `lib/second-brain/triage.ts` (Step 9) |
| Extraction (facts + vision transcription) | Claude Sonnet 5 | `lib/second-brain/extraction.ts` (Step 9) |
| Entity match adjudication (only when trigram+embedding don't produce a clear winner) | Claude Sonnet 5 | `lib/second-brain/matching.ts` (Step 10) |
| Ollama (local, Mac mini) | Not used by anything shipped in Steps 1-12 | The brief scoped this to "enum-constrained classification only" — nothing built so far needed a classification step cheap/local enough to justify it over Haiku |

All three Claude/OpenAI wrappers (`claude.ts`, `embeddings.ts`) are plain
`fetch()` — no `@anthropic-ai/sdk` or heavier `openai` SDK dependency
anywhere in this repo, a deliberate choice matching this codebase's existing
minimal-dependency style (`lib/scraper/` does the same for its one external
HTTP need).

## The verification gate contract

`lib/second-brain/verification-gate.ts`'s `verifyQuote()` is the ONE place
a fact gets checked before it's allowed to become a `change_proposals` row
a human sees. It is deliberately a pure function with zero I/O and zero
model calls — its entire job is catching a hallucinated fact regardless of
which model produced it (Haiku triage, Sonnet extraction, Sonnet vision),
so it cannot itself depend on a model being right.

Two independent checks, both must pass:

1. **Verbatim substring** — `source_quote`, after whitespace normalization
   (`\s+` collapsed to a single space, trimmed), must appear as a substring
   of at least one whitespace-normalized source text: the email's
   `clean_text`, or any of its attachments' `extracted_text` (including a
   vision attachment's own transcription, written back to
   `email_attachments.extracted_text` by the extraction step specifically
   so this check has something real to verify against — see Step 9's own
   commit message for why that mattered).
2. **Value-in-quote** — every number found in the (normalized) quote via
   regex is compared against the fact's own numeric value; at least one
   must match within a small epsilon. This catches the narrower
   hallucination shape check 1 alone would miss: a quote that's genuinely
   real text from the email, but where the extracted number doesn't
   actually match what's written in that real text.

A failure on either check means `change_proposals.status='failed_verification'`
and an `aria_queue` `approval_needed` row — the fact never reaches Phillip
as a normal proposal, and `items` is never touched.

## Where each step actually lives

| Step | What | Files |
|---|---|---|
| 1 | `aria_queue` | `supabase/migrations/033-034` |
| 2 | Queue MCP tools | `app/api/aria-queue/*`, `mcp/src/index.mjs` |
| 3 | Existing events wired to the queue | `app/api/materials/[id]/refresh-price`, `app/api/trade-reminders`, `app/api/leads/queue-sync` |
| 4 | `workspace_index` | `supabase/migrations/035` |
| 5 | Indexer | `app/api/second-brain/reindex`, `lib/second-brain/{content-for,embeddings}.ts` |
| 6 | Hybrid search | `supabase/migrations/036`, `app/api/second-brain/search` |
| 7 | Context snapshot | `app/api/me/context` |
| 8 | Email ingest (Mac mini) | `scripts/email_ingest.py` |
| 9 | Triage + extraction | `app/api/second-brain/{triage,extract}`, `lib/second-brain/{triage,extraction,claude}.ts`, `supabase/migrations/037-038` |
| 10 | Entity matching | `app/api/second-brain/{match,matches/[id]/correct}`, `lib/second-brain/matching.ts`, `supabase/migrations/039` |
| 11 | Proposals + approval | `app/api/second-brain/{propose,proposals/[id]/{approve,reject}}`, `lib/second-brain/verification-gate.ts`, `supabase/migrations/040` |
| 12 | Polish (this doc, truncation guard, `index_rebuild`, heartbeat) | `mcp/src/index.mjs`, `scripts/aria_heartbeat.py` |
| 13 | Visualizer | Optional, not built |
