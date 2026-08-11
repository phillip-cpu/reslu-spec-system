-- Run in the Supabase SQL Editor only after migration 093 succeeds.
-- This exercises a real direct agent conversation twice with one client id,
-- proves exact-once message/job creation, and rolls every test row back.

begin;

create temporary table reslu_message_reliability_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  agent_slug text not null,
  client_message_id uuid not null,
  client_call_id uuid not null,
  client_conversation_id uuid not null,
  attachment_ids uuid[] not null default array[]::uuid[],
  first_message_id uuid,
  second_message_id uuid,
  first_call_id uuid,
  second_call_id uuid,
  first_conversation_id uuid,
  second_conversation_id uuid,
  first_conversation_existing boolean,
  second_conversation_existing boolean
) on commit drop;

insert into reslu_message_reliability_test (
  profile_id,
  conversation_id,
  agent_slug,
  client_message_id,
  client_call_id,
  client_conversation_id
)
select
  human.profile_id,
  conversation.id,
  agent.slug,
  gen_random_uuid(),
  gen_random_uuid(),
  gen_random_uuid()
from conversations conversation
join conversation_participants human
  on human.conversation_id = conversation.id
  and human.profile_id is not null
join conversation_participants agent_link
  on agent_link.conversation_id = conversation.id
  and agent_link.agent_id is not null
join conversation_agents agent
  on agent.id = agent_link.agent_id
  and agent.active
where conversation.kind = 'direct'
  and (
    select count(*)
    from conversation_participants participant
    where participant.conversation_id = conversation.id
  ) = 2
limit 1;

do $$
begin
  if to_regprocedure(
    'public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[])'
  ) is null and to_regprocedure(
    'public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[],uuid)'
  ) is null then
    raise exception 'FAIL: migration 093 function is missing';
  end if;
  if to_regprocedure(
    'public.create_conversation_call_idempotent(uuid,text,uuid)'
  ) is null or to_regprocedure(
    'public.end_conversation_call_idempotent(uuid,uuid,text,jsonb)'
  ) is null then
    raise exception 'FAIL: migration 093 call functions are missing';
  end if;
  if to_regprocedure(
    'public.create_conversation_idempotent(text,uuid[],text[],uuid)'
  ) is null then
    raise exception 'FAIL: migration 093 conversation function is missing';
  end if;

  if not exists (select 1 from reslu_message_reliability_test) then
    raise exception 'FAIL: no direct staff-to-agent conversation exists for the rollback test';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_message_reliability_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

do $$
declare
  test reslu_message_reliability_test%rowtype;
  created record;
begin
  select * into strict test from reslu_message_reliability_test;

  select * into strict created
  from create_conversation_idempotent(
    'Migration 093 exact-once group test',
    array[]::uuid[],
    array['aria', 'marco']::text[],
    test.client_conversation_id
  );
  update reslu_message_reliability_test
  set first_conversation_id = created.conversation_id,
      first_conversation_existing = created.existing;

  select * into strict created
  from create_conversation_idempotent(
    'Migration 093 exact-once group test',
    array[]::uuid[],
    array['aria', 'marco']::text[],
    test.client_conversation_id
  );
  update reslu_message_reliability_test
  set second_conversation_id = created.conversation_id,
      second_conversation_existing = created.existing;
end;
$$;

do $$
declare
  test reslu_message_reliability_test%rowtype;
  created conversation_calls;
begin
  select * into strict test from reslu_message_reliability_test;

  created := create_conversation_call_idempotent(
    test.conversation_id,
    'office',
    test.client_call_id
  );
  update reslu_message_reliability_test set first_call_id = created.id;

  created := create_conversation_call_idempotent(
    test.conversation_id,
    'office',
    test.client_call_id
  );
  update reslu_message_reliability_test set second_call_id = created.id;

  perform end_conversation_call_idempotent(
    test.conversation_id,
    created.id,
    'Migration 093 retry-safe call test',
    jsonb_build_object('schema_version', 1, 'turns', jsonb_build_array())
  );
  perform end_conversation_call_idempotent(
    test.conversation_id,
    created.id,
    'Migration 093 retry-safe call test',
    jsonb_build_object('schema_version', 1, 'turns', jsonb_build_array())
  );
end;
$$;

with inserted as (
  insert into conversation_attachments (
    conversation_id,
    uploaded_by,
    storage_path,
    filename,
    mime_type,
    byte_size,
    status,
    ready_at
  )
  select
    test.conversation_id,
    test.profile_id,
    'rollback-tests/093/' || gen_random_uuid()::text,
    'reliability-' || ordinal::text || '.pdf',
    'application/pdf',
    1,
    'ready',
    now()
  from reslu_message_reliability_test test
  cross join generate_series(1, 2) ordinal
  returning id
)
update reslu_message_reliability_test
set attachment_ids = (select array_agg(id order by id) from inserted);

do $$
declare
  test reslu_message_reliability_test%rowtype;
  created conversation_messages;
begin
  select * into strict test from reslu_message_reliability_test;

  created := create_conversation_message_idempotent(
    test.conversation_id,
    'RESLU migration 093 rollback test',
    jsonb_build_object(
      'source', 'text',
      'target_agent_slugs', jsonb_build_array(test.agent_slug)
    ),
    test.client_message_id,
    test.attachment_ids
  );
  update reslu_message_reliability_test
  set first_message_id = created.id;

  created := create_conversation_message_idempotent(
    test.conversation_id,
    'RESLU migration 093 rollback test',
    jsonb_build_object(
      'source', 'text',
      'target_agent_slugs', jsonb_build_array(test.agent_slug)
    ),
    test.client_message_id,
    test.attachment_ids
  );
  update reslu_message_reliability_test
  set second_message_id = created.id;
end;
$$;

do $$
declare
  test reslu_message_reliability_test%rowtype;
  canonical_message_count integer;
  agent_job_count integer;
  bound_attachment_count integer;
  canonical_call_count integer;
  call_record_count integer;
  canonical_call_status text;
  canonical_conversation_count integer;
  canonical_conversation_participants integer;
  compatibility_message_check text;
begin
  select * into strict test from reslu_message_reliability_test;

  select count(*) into canonical_message_count
  from conversation_messages message
  where message.author_profile_id = test.profile_id
    and message.client_message_id = test.client_message_id;

  select count(*) into agent_job_count
  from agent_conversation_jobs job
  where job.triggering_message_id = test.first_message_id;

  select count(*) into bound_attachment_count
  from conversation_attachments attachment
    where attachment.message_id = test.first_message_id;

  select count(*), max(call.status)
  into canonical_call_count, canonical_call_status
  from conversation_calls call
  where call.started_by = test.profile_id
    and call.client_call_id = test.client_call_id;

  select count(*) into call_record_count
  from conversation_messages message
  where message.conversation_id = test.conversation_id
    and message.kind = 'call_record'
    and message.metadata->>'call_id' = test.first_call_id::text;

  select count(*) into canonical_conversation_count
  from conversations conversation
  where conversation.created_by = test.profile_id
    and conversation.client_conversation_id = test.client_conversation_id;

  select count(*) into canonical_conversation_participants
  from conversation_participants participant
  where participant.conversation_id = test.first_conversation_id;

  select policy.with_check into compatibility_message_check
  from pg_policies policy
  where policy.schemaname = 'public'
    and policy.tablename = 'conversation_messages'
    and policy.policyname = 'members_send_messages';

  if test.first_message_id is null or test.second_message_id is null then
    raise exception 'FAIL: the idempotent send did not return both message ids';
  end if;
  if test.first_message_id <> test.second_message_id then
    raise exception 'FAIL: retry returned a different canonical message';
  end if;
  if canonical_message_count <> 1 then
    raise exception 'FAIL: expected 1 canonical message, found %', canonical_message_count;
  end if;
  if agent_job_count <> 1 then
    raise exception 'FAIL: expected 1 agent job, found %', agent_job_count;
  end if;
  if bound_attachment_count <> 2 then
    raise exception 'FAIL: expected the complete 2-file attachment set, found %', bound_attachment_count;
  end if;
  if test.first_call_id is null or test.second_call_id is null
     or test.first_call_id <> test.second_call_id then
    raise exception 'FAIL: retry returned a different canonical call';
  end if;
  if canonical_call_count <> 1 or canonical_call_status <> 'ended' then
    raise exception 'FAIL: expected 1 ended canonical call, found % with status %', canonical_call_count, canonical_call_status;
  end if;
  if call_record_count <> 1 then
    raise exception 'FAIL: expected 1 canonical call record, found %', call_record_count;
  end if;
  if test.first_conversation_id is null or test.second_conversation_id is null
     or test.first_conversation_id <> test.second_conversation_id
     or test.first_conversation_existing
     or not test.second_conversation_existing then
    raise exception 'FAIL: conversation retry did not return one new then one existing conversation';
  end if;
  if canonical_conversation_count <> 1 or canonical_conversation_participants <> 3 then
    raise exception 'FAIL: expected 1 complete 3-participant conversation, found % conversation(s) with % participants', canonical_conversation_count, canonical_conversation_participants;
  end if;
  if compatibility_message_check is null
     or compatibility_message_check not ilike '%kind%text%'
     or compatibility_message_check not ilike '%author_profile_id%auth.uid%' then
    raise exception 'FAIL: direct compatibility message policy is not restricted to the caller''s text rows';
  end if;

  begin
    perform create_conversation_message_idempotent(
      test.conversation_id,
      'RESLU migration 093 rollback test',
      jsonb_build_object(
        'source', 'text',
        'target_agent_slugs', jsonb_build_array(test.agent_slug)
      ),
      test.client_message_id,
      array[test.attachment_ids[1]]
    );
    raise exception 'FAIL: retry accepted only a subset of the canonical attachment set';
  exception
    when others then
      if sqlerrm = 'FAIL: retry accepted only a subset of the canonical attachment set' then raise; end if;
      if sqlerrm not ilike '%client message id attachment set does not match%' then
        raise exception 'FAIL: unexpected attachment-set retry error: %', sqlerrm;
      end if;
  end;

  begin
    perform create_conversation_message_idempotent(
      test.conversation_id,
      'RESLU migration 093 invalid target rollback test',
      jsonb_build_object(
        'source', 'text',
        'target_agent_slugs', jsonb_build_array(test.agent_slug, test.agent_slug)
      ),
      gen_random_uuid(),
      array[]::uuid[]
    );
    raise exception 'FAIL: duplicate agent targets were accepted';
  exception
    when others then
      if sqlerrm = 'FAIL: duplicate agent targets were accepted' then raise; end if;
      if sqlerrm not ilike '%message agent targets are invalid%' then
        raise exception 'FAIL: unexpected invalid-target error: %', sqlerrm;
      end if;
  end;

  raise notice 'PASS: retries returned one complete conversation, one message/job, one immutable attachment set, one call/record and bounded targeting';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  first_message_id as canonical_message_id,
  second_message_id as retry_message_id,
  first_call_id as canonical_call_id,
  second_call_id as retry_call_id,
  first_conversation_id as canonical_conversation_id,
  second_conversation_id as retry_conversation_id
from reslu_message_reliability_test;

rollback;
