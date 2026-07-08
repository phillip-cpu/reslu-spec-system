-- ============================================================
-- RESLU Spec System — Second Brain, Step 10: entity matching + aliases.
-- docs/RESLU-second-brain-build-brief.md, Step 10.
--
-- entity_aliases and pg_trgm are the brief's own literal schema. The
-- brief never says where MATCH RESULTS get persisted — emails
-- (migration 037) has matched_project_id/match_confidence/
-- match_method, room for exactly ONE match per email, but a single
-- email's extraction (Step 9) can carry several distinct mentions
-- (a job mention plus multiple item mentions), each needing its own
-- match. email_entity_matches (new here) is one row per distinct
-- mention TEXT resolved within an email — Step 11 looks these up by
-- (email_id, lower(trim(source_text))).
--
-- trigram_match() exists because ordering by similarity() can't be
-- expressed through the plain PostgREST/supabase-js query builder —
-- same category of gap as Step 2's claim_aria_queue_items and Step
-- 6's hybrid_search.
-- ============================================================
create extension if not exists pg_trgm;

create table if not exists entity_aliases (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  alias text not null,
  source text not null default 'human_correction',
  created_at timestamptz default now(),
  unique (entity_type, alias)
);

alter table entity_aliases enable row level security;
drop policy if exists "team_all" on entity_aliases;
create policy "team_all" on entity_aliases
  for all to authenticated using (true) with check (true);

comment on table entity_aliases is
  'RESLU Second Brain, Step 10 (docs/RESLU-second-brain-build-brief.md). Human-corrected mention text -> entity mappings, so the same variant auto-links next time via the matching ladder''s rung 2. alias is matched case-insensitively.';

create table if not exists email_entity_matches (
  id             uuid primary key default gen_random_uuid(),
  email_id       uuid not null references emails(id) on delete cascade,
  source_text    text not null,
  entity_type    text not null check (entity_type in ('project', 'item')),
  entity_id      uuid,
  confidence     numeric,
  method         text,
  status         text not null check (status in ('matched', 'review', 'no_match')),
  candidates     jsonb not null default '[]',
  created_at     timestamptz not null default now(),
  resolved_at    timestamptz,
  unique (email_id, entity_type, source_text)
);

create index if not exists idx_email_entity_matches_email_id on email_entity_matches(email_id);
create index if not exists idx_email_entity_matches_status on email_entity_matches(status);

alter table email_entity_matches enable row level security;
drop policy if exists "team_all" on email_entity_matches;
create policy "team_all" on email_entity_matches
  for all to authenticated using (true) with check (true);

comment on table email_entity_matches is
  'RESLU Second Brain, Step 10. One row per distinct mention text resolved from an email''s extraction (Step 9) — job_mentions match entity_type=project, item_mentions/price_facts[].item_text/lead_time_facts[].item_text match entity_type=item, deduplicated by normalized source_text within an email. status: matched (confidence>=0.90, auto-linked), review (0.60-0.90, needs human confirmation — see the paired aria_queue approval_needed row), no_match (<0.60, nothing linked). candidates is the up-to-5 named-candidate list considered, kept for audit even after resolution. Correct a review/no_match row via POST /api/second-brain/matches/[id]/correct, which also writes an entity_aliases row so the same text auto-links next time.';

create or replace function trigram_match(
  query_text text,
  p_entity_type text,
  p_threshold float default 0.55,
  p_limit int default 5
)
returns table (entity_id uuid, name text, similarity float)
language plpgsql
as $$
begin
  -- word_similarity(), not similarity(): plain similarity() penalises
  -- length differences heavily (verified live: similarity('Bayside',
  -- 'Bayside Clinic Fitout') = 0.36, well under the brief's own 0.55
  -- threshold, even though this exact pairing is the brief's own
  -- acceptance example). word_similarity() instead finds the best-
  -- matching substring extent of query_text WITHIN name, which is
  -- what "a short mention matches within a longer real name" actually
  -- needs — confirmed live: word_similarity('Bayside', 'Bayside
  -- Clinic Fitout') clears 0.55 comfortably.
  if p_entity_type = 'item' then
    return query
      select i.id, i.name, word_similarity(query_text, i.name)::float as similarity
      from items i
      where i.deleted_at is null
        and word_similarity(query_text, i.name) > p_threshold
      order by similarity desc
      limit p_limit;
  elsif p_entity_type = 'project' then
    return query
      select p.id, p.name, word_similarity(query_text, p.name)::float as similarity
      from projects p
      where p.deleted_at is null
        and word_similarity(query_text, p.name) > p_threshold
      order by similarity desc
      limit p_limit;
  end if;
end;
$$;

comment on function trigram_match(text, text, float, int) is
  'RESLU Second Brain, Step 10. Rung 3 of the entity-matching ladder (lib/second-brain/matching.ts) — trigram name similarity via pg_trgm, since ordering by similarity() cannot be expressed through the plain query builder. Branches items vs projects internally by p_entity_type.';

notify pgrst, 'reload schema';
