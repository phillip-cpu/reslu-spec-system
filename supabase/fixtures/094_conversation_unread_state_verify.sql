-- Run in the Supabase SQL Editor only after migration 094 succeeds.
-- This proves unread counts and the monotonic read cursor in one real
-- conversation, then rolls every change back.

begin;

create temporary table reslu_unread_state_test (
  profile_id uuid not null,
  conversation_id uuid not null,
  agent_id uuid not null,
  older_message_id uuid,
  newer_message_id uuid,
  read_cursor_after_newer timestamptz,
  read_cursor_message_after_newer uuid
) on commit drop;

insert into reslu_unread_state_test (profile_id, conversation_id, agent_id)
select human.profile_id, human.conversation_id, agent.agent_id
from conversation_participants human
join conversation_participants agent
  on agent.conversation_id = human.conversation_id
 and agent.agent_id is not null
where human.profile_id is not null
limit 1;

do $$
begin
  if to_regprocedure('public.get_conversation_inbox()') is null
     or to_regprocedure('public.mark_conversation_read(uuid,uuid)') is null then
    raise exception 'FAIL: migration 094 functions are missing';
  end if;
  if not exists (select 1 from reslu_unread_state_test) then
    raise exception 'FAIL: no human-to-agent conversation exists for the rollback test';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_unread_state_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

update conversation_participants participant
set
  last_read_at = clock_timestamp(),
  last_read_message_id = 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid
from reslu_unread_state_test test
where participant.conversation_id = test.conversation_id
  and participant.profile_id = test.profile_id;

with marker as (
  -- Future only inside this rollback transaction, ensuring existing chat
  -- history cannot outrank the deterministic test pair.
  select clock_timestamp() + interval '1 minute' as created_at
), generated as (
  select gen_random_uuid() as id
  from generate_series(1, 2)
), inserted as (
  insert into conversation_messages (
    id,
    conversation_id,
    author_agent_id,
    kind,
    body,
    created_at
  )
  select
    generated.id,
    conversation_id,
    agent_id,
    'system',
    'RESLU migration 094 equal-timestamp rollback test ' || generated.id::text,
    marker.created_at
  from reslu_unread_state_test
  cross join marker
  cross join generated
  returning id
), ordered as (
  select array_agg(id order by id) as ids
  from inserted
)
update reslu_unread_state_test
set
  older_message_id = ordered.ids[1],
  newer_message_id = ordered.ids[2]
from ordered;

insert into notifications (
  user_id,
  kind,
  title,
  body,
  source_message_id
)
select
  test.profile_id,
  'conversation_message:' || test.conversation_id::text,
  'Migration 094 exact notification cursor test',
  message.id::text,
  message.id
from reslu_unread_state_test test
join conversation_messages message
  on message.id in (test.older_message_id, test.newer_message_id);

do $$
declare
  test reslu_unread_state_test%rowtype;
  unread_before bigint;
  unread_after_older bigint;
  unread_after bigint;
  cursor_after_older timestamptz;
  cursor_message_after_older uuid;
  inbox_last_message_id uuid;
  unread_notification_count integer;
begin
  select * into strict test from reslu_unread_state_test;

  select inbox.unread_count, inbox.last_message_id
  into unread_before, inbox_last_message_id
  from get_conversation_inbox() inbox
  where inbox.conversation_id = test.conversation_id;
  if unread_before <> 2 then
    raise exception 'FAIL: expected 2 unread messages, found %', unread_before;
  end if;
  if inbox_last_message_id <> test.newer_message_id then
    raise exception 'FAIL: inbox selected the wrong last message for an equal timestamp';
  end if;

  perform mark_conversation_read(test.conversation_id, test.older_message_id);

  select inbox.unread_count into unread_after_older
  from get_conversation_inbox() inbox
  where inbox.conversation_id = test.conversation_id;
  if unread_after_older <> 1 then
    raise exception 'FAIL: equal-timestamp id ordering lost the unread message, found % unread', unread_after_older;
  end if;
  select count(*) into unread_notification_count
  from notifications notification
  where notification.user_id = test.profile_id
    and notification.kind = 'conversation_message:' || test.conversation_id::text
    and notification.source_message_id in (test.older_message_id, test.newer_message_id)
    and notification.read_at is null;
  if unread_notification_count <> 1 then
    raise exception 'FAIL: exact notification cursor should leave only the newer equal-timestamp notification unread, found %', unread_notification_count;
  end if;

  update reslu_unread_state_test state
  set
    read_cursor_after_newer = mark_conversation_read(test.conversation_id, test.newer_message_id),
    read_cursor_message_after_newer = test.newer_message_id;
  select * into strict test from reslu_unread_state_test;

  select inbox.unread_count into unread_after
  from get_conversation_inbox() inbox
  where inbox.conversation_id = test.conversation_id;
  if unread_after <> 0 then
    raise exception 'FAIL: expected 0 unread messages after marking through the newest, found %', unread_after;
  end if;
  select count(*) into unread_notification_count
  from notifications notification
  where notification.user_id = test.profile_id
    and notification.kind = 'conversation_message:' || test.conversation_id::text
    and notification.source_message_id in (test.older_message_id, test.newer_message_id)
    and notification.read_at is null;
  if unread_notification_count <> 0 then
    raise exception 'FAIL: notification cursor did not advance through the newest canonical message';
  end if;

  cursor_after_older := mark_conversation_read(test.conversation_id, test.older_message_id);
  select participant.last_read_message_id into cursor_message_after_older
  from conversation_participants participant
  where participant.conversation_id = test.conversation_id
    and participant.profile_id = test.profile_id;
  if cursor_after_older <> test.read_cursor_after_newer
     or cursor_message_after_older <> test.read_cursor_message_after_newer then
    raise exception 'FAIL: marking an older message moved the read cursor backwards';
  end if;

  raise notice 'PASS: unread count is canonical and the composite read cursor is monotonic';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  conversation_id,
  read_cursor_after_newer,
  read_cursor_message_after_newer
from reslu_unread_state_test;

rollback;
