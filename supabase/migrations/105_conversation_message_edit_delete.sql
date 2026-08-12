-- WhatsApp-like edits and recoverable deletes with an authoritative database
-- boundary. Deleted text is moved out of the shared message row so other
-- conversation members cannot retrieve it through the normal RLS read path.

create table if not exists conversation_message_recoveries (
  message_id         uuid primary key references conversation_messages(id) on delete cascade,
  conversation_id    uuid not null references conversations(id) on delete cascade,
  author_profile_id  uuid not null references profiles(id) on delete cascade,
  original_body      text not null check (char_length(original_body) between 1 and 20000),
  deleted_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '30 days'),
  check (expires_at > deleted_at)
);

create index if not exists conversation_message_recoveries_expiry_idx
  on conversation_message_recoveries(expires_at);

alter table conversation_message_recoveries enable row level security;

drop policy if exists "authors_read_message_recoveries" on conversation_message_recoveries;
create policy "authors_read_message_recoveries"
  on conversation_message_recoveries
  for select to authenticated
  using (author_profile_id = auth.uid() and expires_at > now());

-- Older app versions hid deleted rows at query time but left their body in the
-- shared table. Preserve only still-recoverable human text, then sanitize every
-- existing tombstoned row before the new timeline starts returning tombstones.
insert into conversation_message_recoveries(
  message_id,
  conversation_id,
  author_profile_id,
  original_body,
  deleted_at,
  expires_at
)
select
  message.id,
  message.conversation_id,
  message.author_profile_id,
  message.body,
  message.deleted_at,
  message.deleted_at + interval '30 days'
from conversation_messages message
where message.deleted_at is not null
  and message.deleted_at > now() - interval '30 days'
  and message.author_profile_id is not null
  and message.kind = 'text'
  and message.body <> 'This message was deleted.'
on conflict (message_id) do nothing;

update conversation_messages message
set body = 'This message was deleted.'
where message.deleted_at is not null
  and message.body <> 'This message was deleted.';

create or replace function edit_conversation_message(
  p_conversation_id uuid,
  p_message_id uuid,
  p_body text,
  p_expected_version timestamptz
)
returns conversation_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row conversation_messages;
  normalized_body text;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  normalized_body := btrim(coalesce(p_body, ''));
  if char_length(normalized_body) < 1 or char_length(normalized_body) > 20000 then
    raise exception 'message body is invalid';
  end if;
  if p_expected_version is null then
    raise exception 'message version is required';
  end if;

  select * into message_row
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.author_profile_id = auth.uid()
    and message.author_agent_id is null
    and message.kind = 'text'
  for update;

  if not found then
    raise exception 'message not found';
  end if;
  if message_row.deleted_at is not null then
    raise exception 'deleted messages cannot be edited';
  end if;
  if now() > message_row.created_at + interval '15 minutes' then
    raise exception 'the 15 minute edit window has ended';
  end if;
  if coalesce(message_row.edited_at, message_row.created_at) is distinct from p_expected_version then
    raise exception 'message changed on another device';
  end if;
  if normalized_body = message_row.body then
    return message_row;
  end if;

  update conversation_messages message
  set
    body = normalized_body,
    -- `now()` is fixed at transaction start, so an insert followed by an edit
    -- in one transaction could otherwise retain the same optimistic version.
    -- Advance by at least one PostgreSQL timestamp tick on every real edit.
    edited_at = greatest(
      clock_timestamp(),
      coalesce(message_row.edited_at, message_row.created_at) + interval '1 microsecond'
    )
  where message.id = message_row.id
  returning * into message_row;

  return message_row;
end;
$$;

create or replace function delete_conversation_message_recoverably(
  p_conversation_id uuid,
  p_message_id uuid
)
returns conversation_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row conversation_messages;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  select * into message_row
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.author_profile_id = auth.uid()
    and message.author_agent_id is null
    and message.kind = 'text'
  for update;

  if not found then
    raise exception 'message not found';
  end if;
  if message_row.deleted_at is not null then
    return message_row;
  end if;

  -- Bound private recovery retention without depending on a browser session.
  -- The service cleanup function below may run on a schedule; every new delete
  -- also opportunistically clears expired content.
  delete from conversation_message_recoveries recovery
  where recovery.expires_at <= now();

  insert into conversation_message_recoveries(
    message_id,
    conversation_id,
    author_profile_id,
    original_body,
    deleted_at,
    expires_at
  ) values (
    message_row.id,
    message_row.conversation_id,
    auth.uid(),
    message_row.body,
    now(),
    now() + interval '30 days'
  )
  on conflict (message_id) do nothing;

  update conversation_messages message
  set
    body = 'This message was deleted.',
    deleted_at = now()
  where message.id = message_row.id
  returning * into message_row;

  -- A deleted conversational request must not publish a late reply. Durable
  -- agent_tasks are deliberately independent and are never updated here.
  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = coalesce(job.completed_at, now())
  where job.triggering_message_id = message_row.id
    and job.status in ('pending', 'processing');

  return message_row;
end;
$$;

create or replace function purge_expired_conversation_message_recoveries()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  delete from conversation_message_recoveries recovery
  where recovery.expires_at <= now();
  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function restore_conversation_message(
  p_conversation_id uuid,
  p_message_id uuid
)
returns conversation_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  message_row conversation_messages;
  recovery_row conversation_message_recoveries;
begin
  if auth.uid() is null or p_conversation_id is null or p_message_id is null then
    raise exception 'unauthorized';
  end if;
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  select * into message_row
  from conversation_messages message
  where message.id = p_message_id
    and message.conversation_id = p_conversation_id
    and message.author_profile_id = auth.uid()
    and message.author_agent_id is null
    and message.kind = 'text'
  for update;

  if not found then
    raise exception 'message not found';
  end if;
  if message_row.deleted_at is null then
    return message_row;
  end if;

  select * into recovery_row
  from conversation_message_recoveries recovery
  where recovery.message_id = message_row.id
    and recovery.conversation_id = p_conversation_id
    and recovery.author_profile_id = auth.uid()
  for update;

  if not found or recovery_row.expires_at <= now() then
    raise exception 'this message can no longer be restored';
  end if;

  update conversation_messages message
  set
    body = recovery_row.original_body,
    deleted_at = null,
    metadata = coalesce(message.metadata, '{}'::jsonb)
      || jsonb_build_object('restored_at', now())
  where message.id = message_row.id
  returning * into message_row;

  delete from conversation_message_recoveries recovery
  where recovery.message_id = message_row.id;

  -- Restore is a history operation, not a new send. A cancelled conversational
  -- job stays cancelled and cannot silently re-run business work.
  return message_row;
end;
$$;

revoke all on function edit_conversation_message(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function delete_conversation_message_recoverably(uuid, uuid) from public, anon;
revoke all on function restore_conversation_message(uuid, uuid) from public, anon;
revoke all on function purge_expired_conversation_message_recoveries() from public, anon, authenticated;
grant execute on function edit_conversation_message(uuid, uuid, text, timestamptz) to authenticated;
grant execute on function delete_conversation_message_recoverably(uuid, uuid) to authenticated;
grant execute on function restore_conversation_message(uuid, uuid) to authenticated;
grant execute on function purge_expired_conversation_message_recoveries() to service_role;

comment on table conversation_message_recoveries is
  'Private 30-day recovery content for a soft-deleted human message. Only its author may read it.';
comment on function edit_conversation_message(uuid, uuid, text, timestamptz) is
  'Edits an owned human text message within 15 minutes using optimistic version control; it never re-enqueues an agent.';
comment on function delete_conversation_message_recoverably(uuid, uuid) is
  'Replaces shared text with a tombstone, privately retains it for 30 days and cancels only unfinished conversational output.';
comment on function restore_conversation_message(uuid, uuid) is
  'Restores an owned tombstoned message without re-enqueuing an agent turn.';
comment on function purge_expired_conversation_message_recoveries() is
  'Service-only retention cleanup for deleted message content after its 30-day recovery window.';

notify pgrst, 'reload schema';
