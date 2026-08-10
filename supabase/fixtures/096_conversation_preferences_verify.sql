-- Run in the Supabase SQL Editor only after migration 096 succeeds.
-- This proves mute, pin and archive are private per-participant preferences,
-- then rolls every test change back.

begin;

create temporary table reslu_conversation_preferences_test (
  profile_id uuid not null,
  conversation_id uuid not null
) on commit drop;

insert into reslu_conversation_preferences_test (profile_id, conversation_id)
select participant.profile_id, participant.conversation_id
from conversation_participants participant
where participant.profile_id is not null
limit 1;

do $$
begin
  if to_regprocedure('public.update_conversation_preferences(uuid,boolean,boolean,boolean)') is null then
    raise exception 'FAIL: migration 096 preference function is missing';
  end if;
  if not exists (select 1 from reslu_conversation_preferences_test) then
    raise exception 'FAIL: no human conversation participant exists for the rollback test';
  end if;
  if has_function_privilege('anon', 'public.update_conversation_preferences(uuid,boolean,boolean,boolean)', 'EXECUTE') then
    raise exception 'FAIL: anon can execute the preference function';
  end if;
end;
$$;

select set_config(
  'request.jwt.claim.sub',
  (select profile_id::text from reslu_conversation_preferences_test),
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);

select *
from update_conversation_preferences(
  (select conversation_id from reslu_conversation_preferences_test),
  true,
  false,
  true
);

do $$
declare
  test reslu_conversation_preferences_test%rowtype;
  participant conversation_participants%rowtype;
  inbox record;
begin
  select * into strict test from reslu_conversation_preferences_test;
  select * into strict participant
  from conversation_participants item
  where item.conversation_id = test.conversation_id
    and item.profile_id = test.profile_id;
  select * into strict inbox
  from get_conversation_inbox() item
  where item.conversation_id = test.conversation_id;

  if participant.notifications_muted is not true
     or participant.pinned_at is null
     or participant.archived_at is not null then
    raise exception 'FAIL: mute and pin did not update only the participant inbox row';
  end if;
  if inbox.notifications_muted is not true
     or inbox.pinned_at is null
     or inbox.archived_at is not null then
    raise exception 'FAIL: the inbox RPC did not expose the preference state';
  end if;
end;
$$;

select *
from update_conversation_preferences(
  (select conversation_id from reslu_conversation_preferences_test),
  null,
  true,
  null
);

do $$
declare
  test reslu_conversation_preferences_test%rowtype;
  participant conversation_participants%rowtype;
begin
  select * into strict test from reslu_conversation_preferences_test;
  select * into strict participant
  from conversation_participants item
  where item.conversation_id = test.conversation_id
    and item.profile_id = test.profile_id;

  if participant.archived_at is null or participant.pinned_at is not null then
    raise exception 'FAIL: archiving did not unpin the participant conversation';
  end if;

  begin
    perform *
    from update_conversation_preferences(
      test.conversation_id,
      null,
      true,
      true
    );
    raise exception 'FAIL: one request archived and pinned the same conversation';
  exception
    when others then
      if sqlerrm = 'FAIL: one request archived and pinned the same conversation' then raise; end if;
      if sqlerrm not ilike '%cannot be archived and pinned at the same time%' then
        raise exception 'FAIL: unexpected archive/pin conflict error: %', sqlerrm;
      end if;
  end;
end;
$$;

select *
from update_conversation_preferences(
  (select conversation_id from reslu_conversation_preferences_test),
  false,
  false,
  null
);

do $$
begin
  raise notice 'PASS: mute, pin and archive are private, visible and mutually consistent';
end;
$$;

select
  'PASS — transaction will now roll back' as result,
  conversation_id
from reslu_conversation_preferences_test;

rollback;
