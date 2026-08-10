-- Run in the Supabase SQL Editor only after migration 098 succeeds.
-- This proves quoted replies are same-conversation and idempotent, while the
-- pre-098 five-argument call remains compatible. Everything rolls back.

begin;

create temporary table reslu_quoted_reply_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  target_message_id uuid,
  reply_message_id uuid,
  legacy_message_id uuid,
  reply_client_id uuid not null default gen_random_uuid(),
  legacy_client_id uuid not null default gen_random_uuid()
) on commit drop;

insert into reslu_quoted_reply_test (profile_id, conversation_id)
select participant.profile_id, participant.conversation_id
from conversation_participants participant
where participant.profile_id is not null
limit 1;

do $$
begin
  if to_regprocedure('public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[],uuid)') is null then
    raise exception 'FAIL: migration 098 reply-aware send function is missing';
  end if;
  if to_regprocedure('public.create_conversation_message_idempotent(uuid,text,jsonb,uuid,uuid[])') is not null then
    raise exception 'FAIL: ambiguous five-argument overload still exists';
  end if;
  if not exists (select 1 from reslu_quoted_reply_test) then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;
end;
$$;

with inserted as (
  insert into conversation_messages (conversation_id, author_profile_id, kind, body)
  select conversation_id, profile_id, 'system', 'RESLU migration 098 quoted target'
  from reslu_quoted_reply_test
  returning id
)
update reslu_quoted_reply_test
set target_message_id = inserted.id
from inserted;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_quoted_reply_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

with sent as (
  select message.id
  from reslu_quoted_reply_test test
  cross join lateral create_conversation_message_idempotent(
    test.conversation_id,
    'Reply with exact target',
    '{"source":"text"}'::jsonb,
    test.reply_client_id,
    array[]::uuid[],
    test.target_message_id
  ) message
)
update reslu_quoted_reply_test
set reply_message_id = sent.id
from sent;

-- The old application omits p_reply_to_id. The default must keep that call
-- operational during a database-first deploy.
with sent as (
  select message.id
  from reslu_quoted_reply_test test
  cross join lateral create_conversation_message_idempotent(
    test.conversation_id,
    'Legacy five-argument send',
    '{"source":"text"}'::jsonb,
    test.legacy_client_id,
    array[]::uuid[]
  ) message
)
update reslu_quoted_reply_test
set legacy_message_id = sent.id
from sent;

do $$
declare
  test reslu_quoted_reply_test%rowtype;
  canonical_reply conversation_messages%rowtype;
  canonical_legacy conversation_messages%rowtype;
  retry_id uuid;
begin
  select * into strict test from reslu_quoted_reply_test;
  select * into strict canonical_reply from conversation_messages where id = test.reply_message_id;
  select * into strict canonical_legacy from conversation_messages where id = test.legacy_message_id;

  if canonical_reply.reply_to_id <> test.target_message_id then
    raise exception 'FAIL: canonical reply target was not preserved';
  end if;
  if canonical_legacy.reply_to_id is not null then
    raise exception 'FAIL: legacy send unexpectedly gained a reply target';
  end if;

  update conversation_messages set deleted_at = now() where id = test.target_message_id;
  select message.id into retry_id
  from create_conversation_message_idempotent(
    test.conversation_id,
    'Reply with exact target',
    '{"source":"text"}'::jsonb,
    test.reply_client_id,
    array[]::uuid[],
    test.target_message_id
  ) message;
  if retry_id <> test.reply_message_id then
    raise exception 'FAIL: retry did not return the canonical reply after its target was later deleted';
  end if;

  begin
    perform create_conversation_message_idempotent(
      test.conversation_id,
      'Reply with exact target',
      '{"source":"text"}'::jsonb,
      test.reply_client_id,
      array[]::uuid[],
      null
    );
    raise exception 'FAIL: one client send id changed its reply target';
  exception
    when others then
      if sqlerrm = 'FAIL: one client send id changed its reply target' then raise; end if;
      if sqlerrm not ilike '%client message id was already used for different content%' then
        raise exception 'FAIL: unexpected reply idempotency error: %', sqlerrm;
      end if;
  end;

  raise notice 'PASS: quoted replies are canonical, same-conversation, idempotent and rollout-compatible';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  conversation_id,
  target_message_id,
  reply_message_id,
  legacy_message_id
from reslu_quoted_reply_test;

rollback;
