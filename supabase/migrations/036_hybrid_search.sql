-- ============================================================
-- RESLU Spec System — Second Brain, Step 6: hybrid_search().
-- docs/RESLU-second-brain-build-brief.md, Step 6.
--
-- Reciprocal rank fusion over workspace_index (migration 035): combines
-- full-text (fts, generated tsvector column) and vector similarity
-- (embedding, HNSW-indexed) rankings into one score. Spec data is full
-- of exact codes (product names, AS/NZS references) that embeddings
-- alone tend to miss but full-text catches directly — this is why the
-- brief calls for hybrid rather than vector-only search.
--
-- score = 1/(60+fts_rank) + 1/(60+vec_rank) — the standard RRF
-- constant (60) and formula, matching Supabase's own documented
-- hybrid-search pattern (see this migration's own inline comments for
-- where it deviates).
--
-- plpgsql, not a pure SQL function, specifically so the
-- hnsw.iterative_scan tuning below can be attempted defensively: that
-- GUC only exists on pgvector >=0.8 (it's what stops an entity_type
-- filter from starving HNSW's approximate results — the brief's own
-- stated reason, and the acceptance criterion below depends on it).
-- If the installed pgvector predates 0.8, setting it would error;
-- the exception handler swallows that so search still works
-- correctly, just without this one filtering optimisation, rather
-- than the whole function failing to run on an older extension
-- version.
-- ============================================================
create or replace function hybrid_search(
  query_text text,
  query_embedding vector(1536),
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
    -- pgvector <0.8 (or any other reason this GUC isn't available) —
    -- proceed without it rather than fail the whole search.
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
  'RESLU Second Brain, Step 6 (docs/RESLU-second-brain-build-brief.md). Reciprocal-rank-fusion hybrid search over workspace_index — combines full-text (exact codes like AS 1428, product names) and vector similarity (semantic matches) into one ranked list. Called by POST /api/second-brain/search (Step 6), which embeds query_text via OpenAI text-embedding-3-small before calling this — query and index embeddings must share that exact model.';

notify pgrst, 'reload schema';
