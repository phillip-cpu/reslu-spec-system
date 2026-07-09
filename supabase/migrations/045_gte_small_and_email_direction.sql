-- ============================================================
-- RESLU Spec System — Second Brain go-live: gte-small embedding
-- switch + emails.direction.
--
-- PART 1 — gte-small (384 dims) replacing OpenAI text-embedding-3-small
-- (1536 dims). Decision made in a separate Claude Desktop conversation
-- with Phillip (no artifact in this repo to work from) — the schema
-- change and its reasoning below are this session's own engineering
-- judgment, not a copy of a brief.
--
-- workspace_index is TRUNCATED, not migrated in place: the existing
-- 1536-dim embeddings are numerically meaningless once reinterpreted
-- at 384 dims, and simply changing the column type would leave every
-- row's content_hash still matching on the next indexer run (nothing
-- about the row's CONTENT changed, only the embedding representation)
-- — the indexer would then skip re-embedding everything, leaving
-- embedding permanently null. Truncating forces a full, clean rebuild
-- via GET /api/second-brain/reindex (Step 5), which is the expected
-- next step regardless. This table is a pure derived search index,
-- never source-of-truth data, so truncating and rebuilding it is safe.
--
-- hybrid_search()'s query_embedding parameter changes type
-- (vector(1536) -> vector(384)) — a signature change, so this needs
-- drop + create, not create or replace (which only works when
-- parameter types are unchanged).
-- ============================================================
truncate table workspace_index;

alter table workspace_index drop column embedding;
alter table workspace_index add column embedding vector(384);

drop index if exists workspace_index_hnsw;
create index workspace_index_hnsw on workspace_index
  using hnsw (embedding vector_cosine_ops);

drop function if exists hybrid_search(text, vector, int, text, int);

create function hybrid_search(
  query_text text,
  query_embedding vector(384),
  match_count int default 8,
  filter_type text default null,
  rrf_k int default 60
)
returns table (
  id uuid,
  entity_type text,
  entity_id uuid,
  title text,
  content text,
  score float
)
language plpgsql
as $$
begin
  begin
    execute 'set local hnsw.iterative_scan = relaxed_order';
    execute format('set local hnsw.ef_search = %s', greatest(match_count * 4, 40));
  exception when others then
    null;
  end;

  return query
  with full_text as (
    select wi.id, row_number() over (
      order by ts_rank_cd(wi.fts, websearch_to_tsquery('english', query_text)) desc
    ) as rank_ix
    from workspace_index wi
    where wi.fts @@ websearch_to_tsquery('english', query_text)
      and (filter_type is null or wi.entity_type = filter_type)
    order by rank_ix
    limit least(match_count, 30) * 2
  ),
  semantic as (
    select wi.id, row_number() over (
      order by wi.embedding <#> query_embedding
    ) as rank_ix
    from workspace_index wi
    where wi.embedding is not null
      and (filter_type is null or wi.entity_type = filter_type)
    order by rank_ix
    limit least(match_count, 30) * 2
  )
  select
    wi.id, wi.entity_type, wi.entity_id, wi.title, wi.content,
    (coalesce(1.0 / (rrf_k + full_text.rank_ix), 0.0) +
     coalesce(1.0 / (rrf_k + semantic.rank_ix), 0.0))::float as score
  from full_text
  full outer join semantic on full_text.id = semantic.id
  join workspace_index wi on wi.id = coalesce(full_text.id, semantic.id)
  order by score desc
  limit match_count;
end;
$$;

comment on function hybrid_search(text, vector, int, text, int) is
  'RESLU Second Brain. Reciprocal-rank-fusion hybrid search over workspace_index. Migration 045: query_embedding is now vector(384) (Supabase gte-small via @huggingface/transformers, lib/second-brain/embeddings.ts) — was vector(1536) (OpenAI text-embedding-3-small) through migration 036. Query and index embeddings must share whichever model is currently wired up.';

comment on table workspace_index is
  'RESLU Second Brain. Hybrid vector + full-text search index — one row per project/lead/item/diary/sow/email/skill/memory record, no chunking. Migration 045: embedding is now vector(384) (Supabase gte-small, run in-process via @huggingface/transformers — was OpenAI text-embedding-3-small at 1536 dims through migration 036). content_hash lets the Step 5 indexer skip re-embedding unchanged rows. Populated/kept in sync by the Step 5 Vercel cron indexer. Table was truncated by migration 045 (embedding dimension change) — run GET /api/second-brain/reindex to repopulate.';

-- ============================================================
-- PART 2 — emails.direction
--
-- Phillip wants outbound (Sent folder) mail in the record alongside
-- inbound. Default 'inbound' backfills every already-ingested email
-- correctly with no separate UPDATE. Actually fetching the Sent
-- folder is Mac-mini-side (scripts/email_ingest.py's own IMAP/Gmail
-- API query scope) — this migration only adds the column; see this
-- round's own commit message / README for what still needs doing on
-- that machine. Step 9's triage route filters to direction='inbound'
-- so outbound mail never enters extraction/matching/proposals —
-- doesn't touch or weaken the write-approval gate at all.
-- ============================================================
alter table emails add column if not exists direction text not null default 'inbound'
  check (direction in ('inbound', 'sent'));

comment on column emails.direction is
  'RESLU Second Brain, go-live round (migration 045). inbound = received mail (the only kind Step 9 triage/extraction ever processes); sent = outbound mail from the Sent folder, ingested for the historical record only — never triaged, never reaches change_proposals. Defaults inbound so every pre-existing row is correctly backfilled.';

notify pgrst, 'reload schema';
