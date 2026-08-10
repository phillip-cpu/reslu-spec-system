-- Run in the Supabase SQL Editor only after migration 095 succeeds.
-- This proves enqueue, privacy policy, and mute behavior in a real direct
-- agent conversation, then rolls all test changes back.

begin;

create temporary table reslu_push_delivery_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  agent_id uuid not null,
  subscription_id uuid,
  unmuted_message_id uuid,
  muted_message_id uuid
) on commit drop;

insert into reslu_push_delivery_test (profile_id, conversation_id, agent_id)
select human.profile_id, human.conversation_id, agent.agent_id
from conversation_participants human
join conversation_participants agent
  on agent.conversation_id = human.conversation_id
 and agent.agent_id is not null
where human.profile_id is not null
limit 1;

do $$
begin
  if to_regclass('public.conversation_push_jobs') is null
     or to_regprocedure('public.claim_conversation_push_jobs(integer)') is null then
    raise exception 'FAIL: migration 095 table or claim function is missing';
  end if;
  if not exists (select 1 from reslu_push_delivery_test) then
    raise exception 'FAIL: no human-to-agent conversation exists for the rollback test';
  end if;
end;
$$;

-- Make this device-count assertion deterministic without changing production:
-- existing subscriptions are restored by the enclosing rollback.
delete from push_subscriptions subscription
using reslu_push_delivery_test test
where subscription.user_id = test.profile_id;

with inserted as (
  insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  select
    profile_id,
    'https://push.example.test/' || gen_random_uuid()::text,
    'rollback-test-p256dh',
    'rollback-test-auth'
  from reslu_push_delivery_test
  returning id
)
update reslu_push_delivery_test
set subscription_id = inserted.id
from inserted;

update conversation_participants participant
set notifications_muted = false
from reslu_push_delivery_test test
where participant.conversation_id = test.conversation_id
  and participant.profile_id = test.profile_id;

with inserted as (
  insert into conversation_messages (conversation_id, author_agent_id, kind, body)
  select conversation_id, agent_id, 'text', 'RESLU migration 095 unmuted rollback test'
  from reslu_push_delivery_test
  returning id
)
update reslu_push_delivery_test
set unmuted_message_id = inserted.id
from inserted;

update conversation_participants participant
set notifications_muted = true
from reslu_push_delivery_test test
where participant.conversation_id = test.conversation_id
  and participant.profile_id = test.profile_id;

with inserted as (
  insert into conversation_messages (conversation_id, author_agent_id, kind, body)
  select conversation_id, agent_id, 'text', 'RESLU migration 095 muted rollback test'
  from reslu_push_delivery_test
  returning id
)
update reslu_push_delivery_test
set muted_message_id = inserted.id
from inserted;

do $$
declare
  test reslu_push_delivery_test%rowtype;
  unmuted_jobs integer;
  muted_jobs integer;
  private_policy_count integer;
  subscription_policy_count integer;
  notification_update_columns text[];
begin
  select * into strict test from reslu_push_delivery_test;

  select count(*) into unmuted_jobs
  from conversation_push_jobs job
  join notifications notification on notification.id = job.notification_id
  where job.message_id = test.unmuted_message_id
    and job.recipient_profile_id = test.profile_id
    and job.subscription_id = test.subscription_id
    and notification.user_id = test.profile_id
    and notification.source_message_id = test.unmuted_message_id
    and notification.link_href = '/messages?conversation=' || test.conversation_id::text || '&message=' || test.unmuted_message_id::text;

  select count(*) into muted_jobs
  from conversation_push_jobs job
  where job.message_id = test.muted_message_id
    and job.recipient_profile_id = test.profile_id;

  select count(*) into private_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'notifications'
    and policyname in ('notification_owner_read','notification_owner_update');

  select count(*) into subscription_policy_count
  from pg_policies
  where schemaname = 'public'
    and tablename = 'push_subscriptions'
    and policyname in (
      'push_subscription_owner_read',
      'push_subscription_owner_insert',
      'push_subscription_owner_update',
      'push_subscription_owner_delete'
    );

  select coalesce(array_agg(privilege.column_name order by privilege.column_name), array[]::text[])
  into notification_update_columns
  from information_schema.column_privileges privilege
  where privilege.table_schema = 'public'
    and privilege.table_name = 'notifications'
    and privilege.grantee = 'authenticated'
    and privilege.privilege_type = 'UPDATE';

  if unmuted_jobs <> 1 then
    raise exception 'FAIL: expected exactly one private push job for an unmuted recipient, found %', unmuted_jobs;
  end if;
  if muted_jobs <> 0 then
    raise exception 'FAIL: muted recipient received % push jobs', muted_jobs;
  end if;
  if private_policy_count <> 2 then
    raise exception 'FAIL: private notification owner policies are missing';
  end if;
  if subscription_policy_count <> 4 then
    raise exception 'FAIL: private push subscription owner policies are missing';
  end if;
  if notification_update_columns <> array['read_at']::text[] then
    raise exception 'FAIL: authenticated notification update columns are %, expected only read_at', notification_update_columns;
  end if;

  raise notice 'PASS: canonical message enqueue is private, exact-once and mute-aware';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  unmuted_message_id,
  muted_message_id
from reslu_push_delivery_test;

rollback;
