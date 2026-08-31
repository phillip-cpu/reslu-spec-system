# RESLU Second Brain — Research Notes

Supporting evidence for the design decisions in the build brief. Compiled 8 Jul 2026 from primary sources (Anthropic engineering/docs, Supabase docs, pgvector, OpenAI docs).

## Context layer

**Context engineering.** Anthropic treats context as a finite resource with diminishing returns ("context rot") — target the smallest set of high-signal tokens per step. Prefer just-in-time retrieval via tools over pre-loading, with a small stable core loaded up front. The snapshot + `search()` combo is this hybrid. Clear old tool results aggressively in long-running loops.
→ https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

**Consolidated tools beat call chains.** Anthropic's tool-writing guide recommends replacing frequently chained calls with one workflow-shaped tool (their example: `get_customer_context`). Each eliminated round-trip saves a full inference turn, not just payload. Concise `response_format` variants used ~1/3 the tokens of detailed. Resolve UUIDs to names (reduces hallucination). Cap tool responses (~25k tokens in Claude Code) with errors that tell the agent how to narrow.
→ https://www.anthropic.com/engineering/writing-tools-for-agents

**Prompt caching.** Cache reads 0.1× input (90% off); writes 1.25× (5-min TTL) or 2× (1-hour). Caching matches prefixes — order context stable→volatile: system prompt + tools first, fresh snapshot last. Heartbeats under 5 min keep the cache warm.
→ https://platform.claude.com/docs/en/build-with-claude/prompt-caching

**Batch API.** 50% off input and output, up to 100k requests per batch, most complete within an hour. Stacks with caching (use 1-hour TTL).
→ https://platform.claude.com/docs/en/build-with-claude/batch-processing

**Model routing.** Haiku 4.5 at $1/$5 per Mtok vs Sonnet $3/$15. Route triage/classification to Haiku, reserve Sonnet+ for judgment. Anthropic's ticket-routing guide: retrieving similar labeled examples into the classification prompt lifted accuracy 71%→93% (workspace_index enables this).
→ https://www.anthropic.com/news/claude-haiku-4-5
→ https://docs.anthropic.com/en/docs/about-claude/use-case-guides/ticket-routing

## pgvector / Supabase

**HNSW over IVFFlat** — Supabase benchmarks: ~3× throughput, better accuracy, no training step, stays optimal as data changes.
→ https://supabase.com/docs/guides/ai/vector-indexes · https://supabase.com/blog/increase-performance-pgvector-hnsw

**Hybrid search** — tsvector full-text + vector merged by reciprocal rank fusion in one SQL function. Essential for spec data with exact codes (product names, AS/NZS refs) that embeddings miss.
→ https://supabase.com/docs/guides/ai/hybrid-search

**Filtered HNSW** — approximate indexes filter after scanning; with selective `entity_type` filters use pgvector ≥0.8 `hnsw.iterative_scan = relaxed_order`.
→ https://www.postgresql.org/about/news/pgvector-080-released-2952/

**Embedding refresh** — one embedding per row (composed content string), re-embed only on content-hash change. text-embedding-3-small $0.02/M tokens: entire workspace ≈ cents.
→ https://supabase.com/docs/guides/ai/automatic-embeddings · https://developers.openai.com/api/docs/models/text-embedding-3-small

## Queue polling

Idle polling must cost zero tokens: plain code checks the queue, wakes the model only when rows exist. Batch items per invocation (system prompt paid once, cache-hit). At-least-once delivery → idempotent handlers, dedupe on business key, archive don't delete. Visibility-timeout re-expose for crashed pickups.
→ https://supabase.com/docs/guides/queues/pgmq · https://supabase.com/blog/supabase-queues

## Email pipeline

**Two-stage triage.** Rules first (noreply, newsletters), cheap model classifies, strong model extracts only actionable mail. Anthropic's routing workflow pattern.
→ https://www.anthropic.com/research/building-effective-agents

**Preprocessing.** Quoted replies/signatures dwarf new content — strip with Mailgun Talon or email_reply_parser. HTML→markdown ≈ 80% token reduction on marketing-grade HTML.
→ https://github.com/mailgun/talon · https://github.com/github/email_reply_parser

**Structured extraction.** Schema-constrained (strict tool use) guarantees valid JSON. Mandatory `source_quote` per fact enables the deterministic verification gate and fast human review. Claude native PDF support: text+visuals, ~1,500–3,000 tokens/page — use only for scanned docs, relevant pages only; pdftotext handles text-layer PDFs free.
→ https://platform.claude.com/docs/en/build-with-claude/structured-outputs
→ https://platform.claude.com/docs/en/build-with-claude/pdf-support

**Entity resolution.** LLMs match entities at/above trained matchers zero-shot; production pattern is layered signals (exact/alias → trigram → embedding → LLM adjudication) with three confidence bands and a no-match threshold. Human corrections feed an alias table.
→ https://arxiv.org/pdf/2310.11244 · https://arxiv.org/pdf/2309.00789

**Human-in-the-loop.** Pause before consequential/irreversible actions; approve/edit/reject per action. Proposals table = audit trail. Never auto-apply prices or lead times; never auto-send client-facing output.
→ https://www.anthropic.com/research/building-effective-agents · https://docs.langchain.com/oss/python/langchain/human-in-the-loop

## Local model (Ollama) policy

Local models hallucinate under generation. Structurally safe local jobs only: enum-constrained classification (grammar-constrained output — cannot invent values). All value extraction (prices, lead times, dates) comes from regex or Claude, and every value passes the string-match verification gate (script, not model) before becoming a proposal.

## Indicative token economics

Per email: raw HTML ~5,200 tok → markdown ~1,400 → stripped ~610. Haiku triage kills ~70% of mail before extraction. Pipeline at ~50 emails/day ≈ 3.5M tokens/month ≈ $10–12. Naive equivalent (no strip, no triage, no cache, model-polled heartbeats) ≈ $150–250/month.
