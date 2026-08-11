-- Run in the Supabase SQL Editor only after migration 095 succeeds.
-- This is one atomic statement: it proves enqueue, privacy policy, and mute
-- behavior in a real direct agent conversation, then rolls its test data back.

do $verify$
declare
  v_profile_id uuid;
  v_conversation_id uuid;
  v_agent_id uuid;
  v_subscription_id uuid;
  v_unmuted_message_id uuid;
  v_muted_message_id uuid;
  v_unmuted_jobs integer;
  v_muted_jobs integer;
  v_private_policy_count integer;
  v_subscription_policy_count integer;
  v_notification_update_columns text[];
begin
  if to_regclass('public.conversation_push_jobs') is null
     or to_regprocedure('public.claim_conversation_push_jobs(integer)') is null then
    raise exception 'FAIL: migration 095 table or claim function is missing';
  end if;

  select human.profile_id, human.conversation_id, agent.agent_id
  into v_profile_id, v_conversation_id, v_agent_id
  from conversation_participants human
  join conversation_participants agent
    on agent.conversation_id = human.conversation_id
   and agent.agent_id is not null
  where human.profile_id is not null
  limit 1;

  if v_profile_id is null or v_conversation_id is null or v_agent_id is null then
    raise exception 'FAIL: no human-to-agent conversation exists for the rollback test';
  end if;

  -- The deliberate success exception at the bottom rolls back this inner
  -- subtransaction. Any genuine failure escapes and also rolls back the whole
  -- statement, so the verifier can never retain its test rows or preferences.
  begin
    delete from push_subscriptions
    where user_id = v_profile_id;

    insert into push_subscriptions (user_id, endpoint, p256dh, auth)
    values (
      v_profile_id,
      'https://push.example.test/' || gen_random_uuid()::text,
      'rollback-test-p256dh',
      'rollback-test-auth'
    )
    returning id into v_subscription_id;

    update conversation_participants
    set notifications_muted = false
    where conversation_id = v_conversation_id
      and profile_id = v_profile_id;

    insert into conversation_messages (
      conversation_id,
      author_agent_id,
      kind,
      body
    ) values (
      v_conversation_id,
      v_agent_id,
      'text',
      'RESLU migration 095 unmuted rollback test'
    )
    returning id into v_unmuted_message_id;

    update conversation_participants
    set notifications_muted = true
    where conversation_id = v_conversation_id
      and profile_id = v_profile_id;

    insert into conversation_messages (
      conversation_id,
      author_agent_id,
      kind,
      body
    ) values (
      v_conversation_id,
      v_agent_id,
      'text',
      'RESLU migration 095 muted rollback test'
    )
    returning id into v_muted_message_id;

    select count(*) into v_unmuted_jobs
    from conversation_push_jobs job
    join notifications notification on notification.id = job.notification_id
    where job.message_id = v_unmuted_message_id
      and job.recipient_profile_id = v_profile_id
      and job.subscription_id = v_subscription_id
      and notification.user_id = v_profile_id
      and notification.source_message_id = v_unmuted_message_id
      and notification.link_href = '/messages?conversation=' || v_conversation_id::text
        || '&message=' || v_unmuted_message_id::text;

    select count(*) into v_muted_jobs
    from conversation_push_jobs job
    where job.message_id = v_muted_message_id
      and job.recipient_profile_id = v_profile_id;

    select count(*) into v_private_policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = 'notifications'
      and policyname in ('notification_owner_read', 'notification_owner_update');

    select count(*) into v_subscription_policy_count
    from pg_policies
    where schemaname = 'public'
      and tablename = 'push_subscriptions'
      and policyname in (
        'push_subscription_owner_read',
        'push_subscription_owner_insert',
        'push_subscription_owner_update',
        'push_subscription_owner_delete'
      );

    select coalesce(
      array_agg(privilege.column_name order by privilege.column_name),
      array[]::text[]
    )
    into v_notification_update_columns
    from information_schema.column_privileges privilege
    where privilege.table_schema = 'public'
      and privilege.table_name = 'notifications'
      and privilege.grantee = 'authenticated'
      and privilege.privilege_type = 'UPDATE';

    if v_unmuted_jobs <> 1 then
      raise exception
        'FAIL: expected exactly one private push job for an unmuted recipient, found %',
        v_unmuted_jobs;
    end if;
    if v_muted_jobs <> 0 then
      raise exception 'FAIL: muted recipient received % push jobs', v_muted_jobs;
    end if;
    if v_private_policy_count <> 2 then
      raise exception 'FAIL: private notification owner policies are missing';
    end if;
    if v_subscription_policy_count <> 4 then
      raise exception 'FAIL: private push subscription owner policies are missing';
    end if;
    if v_notification_update_columns <> array['read_at']::text[] then
      raise exception
        'FAIL: authenticated notification update columns are %, expected only read_at',
        v_notification_update_columns;
    end if;

    raise exception using
      errcode = 'P5095',
      message = 'RESLU_VERIFY_095_PASS';
  exception
    when sqlstate 'P5095' then
      if sqlerrm <> 'RESLU_VERIFY_095_PASS' then
        raise;
      end if;
      raise notice 'PASS: canonical message enqueue is private, exact-once and mute-aware; all test changes rolled back';
  end;
end;
$verify$;
