-- Durable per-recipient push delivery for canonical RESLU messages.
-- A database trigger covers human API sends and direct Aria/Marco bridge
-- inserts equally; the delivery worker never becomes a second message store.

alter table notifications
  add column if not exists source_message_id uuid
  references conversation_messages(id) on delete cascade;

create unique index if not exists notifications_conversation_message_recipient_unique
  on notifications(user_id, source_message_id)
  where user_id is not null and source_message_id is not null;

create table if not exists conversation_push_jobs (
  id                   uuid primary key default gen_random_uuid(),
  message_id           uuid not null references conversation_messages(id) on delete cascade,
  recipient_profile_id uuid not null references profiles(id) on delete cascade,
  subscription_id      uuid not null references push_subscriptions(id) on delete cascade,
  notification_id      uuid not null references notifications(id) on delete cascade,
  delivery_token       uuid not null default gen_random_uuid(),
  status               text not null default 'pending'
                       check (status in ('pending','processing','sent','skipped','failed')),
  attempts             integer not null default 0 check (attempts >= 0),
  next_attempt_at      timestamptz,
  claimed_at           timestamptz,
  completed_at         timestamptz,
  last_error           text,
  created_at           timestamptz not null default now(),
  unique (message_id, recipient_profile_id, subscription_id),
  unique (delivery_token)
);

create index if not exists conversation_push_jobs_claim_idx
  on conversation_push_jobs(status, next_attempt_at, created_at)
  where status in ('pending','processing','failed');

alter table conversation_push_jobs enable row level security;

-- Migration 053 originally used a team-wide policy because pushes carried no
-- private payload. Device endpoints and encryption keys are credentials and
-- must be visible and mutable only to their owner.
drop policy if exists "team_all" on push_subscriptions;
drop policy if exists "push_subscription_owner_read" on push_subscriptions;
drop policy if exists "push_subscription_owner_insert" on push_subscriptions;
drop policy if exists "push_subscription_owner_update" on push_subscriptions;
drop policy if exists "push_subscription_owner_delete" on push_subscriptions;

create policy "push_subscription_owner_read" on push_subscriptions
  for select to authenticated using (user_id = auth.uid());
create policy "push_subscription_owner_insert" on push_subscriptions
  for insert to authenticated with check (user_id = auth.uid());
create policy "push_subscription_owner_update" on push_subscriptions
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
create policy "push_subscription_owner_delete" on push_subscriptions
  for delete to authenticated using (user_id = auth.uid());

-- Conversation notification rows contain private message previews. Replace
-- the original team-wide policy before populating user-specific rows.
drop policy if exists "team_all" on notifications;
drop policy if exists "notification_owner_read" on notifications;
drop policy if exists "notification_owner_update" on notifications;
drop policy if exists "team_create_admin_notifications" on notifications;
drop policy if exists "admins_delete_notifications" on notifications;

create policy "notification_owner_read" on notifications
  for select to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id is null
      and exists (select 1 from profiles where id = auth.uid() and role = 'admin')
    )
  );

create policy "notification_owner_update" on notifications
  for update to authenticated
  using (
    user_id = auth.uid()
    or (
      user_id is null
      and exists (select 1 from profiles where id = auth.uid() and role = 'admin')
    )
  )
  with check (
    user_id = auth.uid()
    or (
      user_id is null
      and exists (select 1 from profiles where id = auth.uid() and role = 'admin')
    )
  );

-- Existing authenticated business routes create all-admin rows (user_id
-- null). Only trusted security-definer/service-role code may address a
-- notification to a particular user.
create policy "team_create_admin_notifications" on notifications
  for insert to authenticated
  with check (user_id is null);

create policy "admins_delete_notifications" on notifications
  for delete to authenticated
  using (exists (select 1 from profiles where id = auth.uid() and role = 'admin'));

-- RLS chooses the row; column grants prevent a recipient from rewriting a
-- private notification's title, body, link or source message through the
-- public Supabase client. Authenticated routes only need to mark it read.
revoke update on notifications from authenticated;
grant update(read_at) on notifications to authenticated;

create or replace function enqueue_conversation_push_jobs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  recipient record;
  notification_row_id uuid;
  author_name text;
begin
  if new.deleted_at is not null or new.kind not in ('text','meeting_record') then
    return new;
  end if;

  select coalesce(profile.full_name, agent.display_name, 'RESLU')
  into author_name
  from (select 1) seed
  left join profiles profile on profile.id = new.author_profile_id
  left join conversation_agents agent on agent.id = new.author_agent_id;

  for recipient in
    select participant.profile_id
    from conversation_participants participant
    where participant.conversation_id = new.conversation_id
      and participant.profile_id is not null
      and participant.profile_id is distinct from new.author_profile_id
      and not participant.notifications_muted
  loop
    insert into notifications (
      user_id,
      kind,
      title,
      body,
      link_href,
      source_message_id
    ) values (
      recipient.profile_id,
      'conversation_message:' || new.conversation_id::text,
      author_name,
      left(new.body, 240),
      '/messages?conversation=' || new.conversation_id::text || '&message=' || new.id::text,
      new.id
    )
    on conflict (user_id, source_message_id)
      where user_id is not null and source_message_id is not null
      do update set source_message_id = excluded.source_message_id
    returning id into notification_row_id;

    -- One durable job per subscribed device avoids retrying devices that have
    -- already succeeded when a different device has a transient failure.
    insert into conversation_push_jobs (
      message_id,
      recipient_profile_id,
      subscription_id,
      notification_id
    )
    select
      new.id,
      recipient.profile_id,
      subscription.id,
      notification_row_id
    from push_subscriptions subscription
    where subscription.user_id = recipient.profile_id
    on conflict (message_id, recipient_profile_id, subscription_id) do nothing;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_conversation_message_push_enqueue on conversation_messages;
create trigger trg_conversation_message_push_enqueue
  after insert on conversation_messages
  for each row execute function enqueue_conversation_push_jobs();

revoke all on function enqueue_conversation_push_jobs() from public, anon, authenticated;

create or replace function claim_conversation_push_jobs(p_limit integer default 10)
returns setof conversation_push_jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update conversation_push_jobs job
  set
    status = 'processing',
    attempts = job.attempts + 1,
    delivery_token = gen_random_uuid(),
    claimed_at = now(),
    next_attempt_at = null,
    last_error = null
  where job.id in (
    select candidate.id
    from conversation_push_jobs candidate
    where candidate.attempts < 6
      and (
        candidate.status = 'pending'
        or (candidate.status = 'failed' and coalesce(candidate.next_attempt_at, now()) <= now())
        or (candidate.status = 'processing' and candidate.claimed_at < now() - interval '2 minutes')
      )
    order by candidate.created_at
    for update skip locked
    limit greatest(1, least(coalesce(p_limit, 10), 50))
  )
  returning job.*;
end;
$$;

revoke all on function claim_conversation_push_jobs(integer) from public, anon, authenticated;
grant execute on function claim_conversation_push_jobs(integer) to service_role;

comment on table conversation_push_jobs is
  'Durable per-device wake-up delivery for canonical conversation messages. The notification body remains private in notifications; delivery_token authorizes only one device job at the Vercel sender.';
comment on function enqueue_conversation_push_jobs() is
  'Creates one private notification per unmuted human recipient and one durable push job per subscribed device whenever a canonical text or meeting record is inserted by the API or agent bridge.';

notify pgrst, 'reload schema';
