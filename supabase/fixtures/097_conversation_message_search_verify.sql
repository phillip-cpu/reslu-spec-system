-- Run in the Supabase SQL Editor only after migration 097 succeeds.
-- This proves membership-scoped literal search and the performance index,
-- then rolls every test change back.

begin;

create temporary table reslu_conversation_search_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  literal_message_id uuid,
  decoy_message_id uuid
) on commit drop;

insert into reslu_conversation_search_test (profile_id, conversation_id)
select participant.profile_id, participant.conversation_id
from conversation_participants participant
where participant.profile_id is not null
limit 1;

do $$
begin
  if to_regprocedure('public.search_conversation_messages(uuid,text,integer)') is null then
    raise exception 'FAIL: migration 097 search function is missing';
  end if;
  if not exists (select 1 from reslu_conversation_search_test) then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;
  if not exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'conversation_messages_body_trgm_idx'
      and indexdef ilike '%using gin%'
      and indexdef ilike '%gin_trgm_ops%'
  ) then
    raise exception 'FAIL: trigram search index is missing';
  end if;
  if has_function_privilege('anon', 'public.search_conversation_messages(uuid,text,integer)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute conversation search';
  end if;
end;
$$;

with inserted as (
  insert into conversation_messages (conversation_id, author_profile_id, kind, body)
  select conversation_id, profile_id, 'system', 'RESLU migration 097 literal 100% search marker'
  from reslu_conversation_search_test
  returning id
)
update reslu_conversation_search_test
set literal_message_id = inserted.id
from inserted;

with inserted as (
  insert into conversation_messages (conversation_id, author_profile_id, kind, body)
  select conversation_id, profile_id, 'system', 'RESLU migration 097 decoy 1000 search marker'
  from reslu_conversation_search_test
  returning id
)
update reslu_conversation_search_test
set decoy_message_id = inserted.id
from inserted;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_conversation_search_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  test reslu_conversation_search_test%rowtype;
  matched_ids uuid[];
begin
  select * into strict test from reslu_conversation_search_test;
  select array_agg(message.id) into matched_ids
  from search_conversation_messages(test.conversation_id, '100%', 50) message;

  if coalesce(cardinality(matched_ids), 0) <> 1 or matched_ids[1] <> test.literal_message_id then
    raise exception 'FAIL: wildcard characters were not searched literally: %', matched_ids;
  end if;

  begin
    perform *
    from search_conversation_messages(test.conversation_id, '100%', null);
    raise exception 'FAIL: a null result limit bypassed the search bound';
  exception
    when others then
      if sqlerrm = 'FAIL: a null result limit bypassed the search bound' then raise; end if;
      if sqlerrm not ilike '%search limit must be between 1 and 50%' then
        raise exception 'FAIL: unexpected null search-limit error: %', sqlerrm;
      end if;
  end;

  raise notice 'PASS: canonical message search is private, literal, bounded and indexed';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  conversation_id,
  literal_message_id
from reslu_conversation_search_test;

rollback;
