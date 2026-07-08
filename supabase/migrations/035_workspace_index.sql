-- ============================================================
-- RESLU Spec System — Second Brain, Step 4: workspace_index.
-- docs/RESLU-second-brain-build-brief.md, Step 4.
--
-- `create extension if not exists vector` is folded into this
-- migration itself rather than relying solely on the brief's Step 0
-- manual prerequisite — idempotent either way (a no-op if already
-- enabled via the Supabase dashboard, enables it here if not), so
-- this migration is self-sufficient regardless of whether that manual
-- step happened first.
--
-- One row per record, no chunking (per the brief) — `content` is a
-- composed string of an entity's key fields, populated by the Step 5
-- indexer's content_for(entity) function (not written yet — this
-- migration is schema-only, same "one step, stop, verify" discipline
-- as every prior step). `embedding` and `fts` stay null/empty until
-- that indexer runs; both are nullable/generated so this table is
-- valid and queryable immediately after this migration, empty.
--
-- Conventions carried over from every prior migration in this round
-- (033/034 most recently): text + check instead of enum, permissive
-- "team_all" RLS policy, idempotent throughout.
-- ============================================================
create extension if not exists vector;

create table if not exists workspace_index (
  id           uuid primary key default gen_random_uuid(),
  entity_type  text not null check (entity_type in
                 ('project','lead','item','diary','sow','email','skill','memory')),
  entity_id    uuid not null,
  title        text not null,
  content      text not null,
  content_hash text not null,
  metadata     jsonb not null default '{}',
  fts          tsvector generated always as
                 (to_tsvector('english', title || ' ' || content)) stored,
  embedding    vector(1536),
  updated_at   timestamptz not null default now(),
  unique (entity_type, entity_id)
);

create index if not exists workspace_index_hnsw on workspace_index
  using hnsw (embedding vector_cosine_ops);
create index if not exists workspace_index_fts on workspace_index using gin (fts);
create index if not exists workspace_index_type on workspace_index (entity_type);

alter table workspace_index enable row level security;

drop policy if exists "team_all" on workspace_index;
create policy "team_all" on workspace_index
  for all to authenticated using (true) with check (true);

comment on table workspace_index is
  'RESLU Second Brain, Step 4 (docs/RESLU-second-brain-build-brief.md). Hybrid vector + full-text search index — one row per project/lead/item/diary/sow/email/skill/memory record, no chunking. embedding is OpenAI text-embedding-3-small (1536 dims) — query and index embeddings must share this exact model. content_hash (sha256 of content) lets the Step 5 indexer skip re-embedding unchanged rows. Populated/kept in sync by the Step 5 Vercel cron indexer (not yet built by this migration) — empty immediately after this migration applies. Read via the Step 6 hybrid_search() function + search MCP tool.';

notify pgrst, 'reload schema';
