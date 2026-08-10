-- Trustworthy conversation sends: one client send intent can create at most
-- one canonical message, even if Safari loses the response and retries.

alter table conversation_messages
  add column if not exists client_message_id uuid;

alter table conversations
  add column if not exists client_conversation_id uuid;

create unique index if not exists conversations_client_create_unique
  on conversations(created_by, client_conversation_id)
  where client_conversation_id is not null;

create unique index if not exists conversation_messages_client_send_unique
  on conversation_messages(author_profile_id, client_message_id)
  where author_profile_id is not null and client_message_id is not null;

alter table conversation_calls
  add column if not exists client_call_id uuid;

create unique index if not exists conversation_calls_client_start_unique
  on conversation_calls(started_by, client_call_id)
  where client_call_id is not null;

create unique index if not exists conversation_messages_call_record_unique
  on conversation_messages ((metadata->>'call_id'))
  where kind = 'call_record' and metadata ? 'call_id';

create or replace function create_conversation_idempotent(
  p_title text,
  p_profile_ids uuid[],
  p_agent_slugs text[],
  p_client_conversation_id uuid
)
returns table(conversation_id uuid, existing boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_title text;
  normalized_profile_ids uuid[];
  normalized_agent_slugs text[];
  normalized_agent_ids uuid[];
  expected_count integer;
  valid_profile_count integer;
  existing_id uuid;
  existing_kind text;
  existing_title text;
  existing_participant_count integer;
  matching_participant_count integer;
  requested_kind text;
  direct_lock_key text;
begin
  if auth.uid() is null then
    raise exception 'unauthorized';
  end if;
  if p_client_conversation_id is null then
    raise exception 'client conversation id is required';
  end if;
  if p_title is not null and char_length(btrim(p_title)) > 200 then
    raise exception 'conversation title is too long';
  end if;
  normalized_title := nullif(btrim(coalesce(p_title, '')), '');

  if cardinality(coalesce(p_profile_ids, array[]::uuid[])) > 49
     or cardinality(coalesce(p_agent_slugs, array[]::text[])) > 2 then
    raise exception 'too many conversation participants';
  end if;
  if array_position(coalesce(p_profile_ids, array[]::uuid[]), null) is not null
     or array_position(coalesce(p_agent_slugs, array[]::text[]), null) is not null then
    raise exception 'conversation participants are invalid';
  end if;
  if cardinality(coalesce(p_profile_ids, array[]::uuid[])) <> (
    select count(distinct value) from unnest(coalesce(p_profile_ids, array[]::uuid[])) value
  ) then
    raise exception 'conversation participants must be unique';
  end if;
  if cardinality(coalesce(p_agent_slugs, array[]::text[])) <> (
    select count(distinct value) from unnest(coalesce(p_agent_slugs, array[]::text[])) value
  ) then
    raise exception 'conversation participants must be unique';
  end if;
  if exists (
    select 1
    from unnest(coalesce(p_agent_slugs, array[]::text[])) slug
    where slug not in ('aria', 'marco')
  ) then
    raise exception 'conversation agents are invalid';
  end if;

  select array_agg(profile_id order by profile_id)
  into normalized_profile_ids
  from (
    select distinct profile_id
    from unnest(array_append(coalesce(p_profile_ids, array[]::uuid[]), auth.uid())) profile_id
  ) requested_profiles;

  select count(*) into valid_profile_count
  from profiles profile
  where profile.id = any(normalized_profile_ids);
  if valid_profile_count <> cardinality(normalized_profile_ids) then
    raise exception 'one or more participants are unavailable';
  end if;

  select
    coalesce(array_agg(agent.slug order by agent.slug), array[]::text[]),
    coalesce(array_agg(agent.id order by agent.slug), array[]::uuid[])
  into normalized_agent_slugs, normalized_agent_ids
  from conversation_agents agent
  where agent.slug = any(coalesce(p_agent_slugs, array[]::text[]))
    and agent.active;
  if cardinality(normalized_agent_slugs) <> cardinality(coalesce(p_agent_slugs, array[]::text[])) then
    raise exception 'one or more participants are unavailable';
  end if;

  expected_count := cardinality(normalized_profile_ids) + cardinality(normalized_agent_ids);
  if expected_count < 2 then
    raise exception 'choose at least one other person or agent';
  end if;
  if expected_count > 50 then
    raise exception 'too many conversation participants';
  end if;
  requested_kind := case when expected_count = 2 then 'direct' else 'group' end;

  -- The device intent lock makes group creation exact-once even if Safari
  -- loses the HTTP response and retries while the first transaction commits.
  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':conversation:' || p_client_conversation_id::text, 0)
  );

  select conversation.id, conversation.kind, conversation.title
  into existing_id, existing_kind, existing_title
  from conversations conversation
  where conversation.created_by = auth.uid()
    and conversation.client_conversation_id = p_client_conversation_id;

  if found then
    select
      count(*),
      count(*) filter (
        where (participant.profile_id is not null and participant.profile_id = any(normalized_profile_ids))
           or (participant.agent_id is not null and participant.agent_id = any(normalized_agent_ids))
      )
    into existing_participant_count, matching_participant_count
    from conversation_participants participant
    where participant.conversation_id = existing_id;
    if existing_kind <> requested_kind
       or existing_title is distinct from normalized_title
       or existing_participant_count <> expected_count
       or matching_participant_count <> expected_count then
      raise exception 'client conversation id was already used for different content';
    end if;
    return query select existing_id, true;
    return;
  end if;

  if requested_kind = 'direct' then
    direct_lock_key := array_to_string(normalized_profile_ids, ',')
      || ':' || array_to_string(normalized_agent_ids, ',');
    perform pg_advisory_xact_lock(hashtextextended('direct-conversation:' || direct_lock_key, 0));

    select conversation.id into existing_id
    from conversations conversation
    where conversation.kind = 'direct'
      and conversation.archived_at is null
      and (
        select count(*)
        from conversation_participants participant
        where participant.conversation_id = conversation.id
      ) = expected_count
      and not exists (
        select 1
        from conversation_participants participant
        where participant.conversation_id = conversation.id
          and not (
            (participant.profile_id is not null and participant.profile_id = any(normalized_profile_ids))
            or (participant.agent_id is not null and participant.agent_id = any(normalized_agent_ids))
          )
      )
    order by conversation.created_at, conversation.id
    limit 1;
    if found then
      return query select existing_id, true;
      return;
    end if;
  end if;

  insert into conversations (
    kind,
    title,
    created_by,
    client_conversation_id
  ) values (
    requested_kind,
    normalized_title,
    auth.uid(),
    p_client_conversation_id
  )
  returning id into existing_id;

  insert into conversation_participants (conversation_id, profile_id, agent_id)
  select existing_id, profile_id, null::uuid
  from unnest(normalized_profile_ids) profile_id
  union all
  select existing_id, null::uuid, agent_id
  from unnest(normalized_agent_ids) agent_id;

  return query select existing_id, false;
end;
$$;

revoke all on function create_conversation_idempotent(text, uuid[], text[], uuid) from public, anon;
grant execute on function create_conversation_idempotent(text, uuid[], text[], uuid) to authenticated;

comment on column conversations.client_conversation_id is
  'Stable device-generated create intent for exact-once group creation after a lost HTTP response.';
comment on function create_conversation_idempotent(text, uuid[], text[], uuid) is
  'Validates and creates a complete conversation and participant set atomically; reuses exact direct chats.';

create or replace function create_conversation_call_idempotent(
  p_conversation_id uuid,
  p_presentation text,
  p_client_call_id uuid
)
returns conversation_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_row conversation_calls;
begin
  if p_conversation_id is null
     or auth.uid() is null
     or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if p_client_call_id is null then
    raise exception 'client call id is required';
  end if;
  if p_presentation is null
     or p_presentation not in ('office', 'driving', 'meeting') then
    raise exception 'call presentation is invalid';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':call:' || p_client_call_id::text, 0)
  );

  select * into call_row
  from conversation_calls call
  where call.started_by = auth.uid()
    and call.client_call_id = p_client_call_id;

  if found then
    if call_row.conversation_id <> p_conversation_id
       or call_row.presentation <> p_presentation then
      raise exception 'client call id was already used for a different call';
    end if;
    return call_row;
  end if;

  insert into conversation_calls (
    conversation_id,
    started_by,
    presentation,
    client_call_id
  ) values (
    p_conversation_id,
    auth.uid(),
    p_presentation,
    p_client_call_id
  )
  returning * into call_row;

  return call_row;
end;
$$;

revoke all on function create_conversation_call_idempotent(uuid, text, uuid) from public, anon;
grant execute on function create_conversation_call_idempotent(uuid, text, uuid) to authenticated;

create or replace function end_conversation_call_idempotent(
  p_conversation_id uuid,
  p_call_id uuid,
  p_summary text default null,
  p_voice_latency jsonb default null
)
returns conversation_calls
language plpgsql
security definer
set search_path = public
as $$
declare
  call_row conversation_calls;
  effective_summary text;
  duration_seconds integer;
  record_body text;
  record_metadata jsonb;
begin
  if auth.uid() is null or p_conversation_id is null then
    raise exception 'unauthorized';
  end if;
  if p_call_id is null then
    raise exception 'call id is required';
  end if;
  if p_summary is not null and char_length(btrim(p_summary)) > 2000 then
    raise exception 'call summary is too long';
  end if;
  if p_voice_latency is not null then
    if jsonb_typeof(p_voice_latency) <> 'object'
       or pg_column_size(p_voice_latency) > 32768 then
      raise exception 'voice latency metadata is invalid';
    end if;
  end if;

  select * into call_row
  from conversation_calls call
  where call.id = p_call_id
    and call.conversation_id = p_conversation_id
    and call.started_by = auth.uid()
  for update;

  if not found then
    raise exception 'call not found';
  end if;
  if call_row.status not in ('active', 'ended') then
    raise exception 'call cannot be ended from its current state';
  end if;

  effective_summary := coalesce(nullif(btrim(p_summary), ''), call_row.summary);
  if call_row.status = 'active' then
    update conversation_calls call
    set
      status = 'ended',
      ended_at = now(),
      summary = effective_summary,
      metadata = case
        when p_voice_latency is null then call.metadata
        else coalesce(call.metadata, '{}'::jsonb)
          || jsonb_build_object('realtime_voice_latency', p_voice_latency)
      end
    where call.id = p_call_id
    returning * into call_row;
  elsif effective_summary is distinct from call_row.summary or p_voice_latency is not null then
    update conversation_calls call
    set
      summary = effective_summary,
      metadata = case
        when p_voice_latency is null then call.metadata
        else coalesce(call.metadata, '{}'::jsonb)
          || jsonb_build_object('realtime_voice_latency', p_voice_latency)
      end
    where call.id = p_call_id
    returning * into call_row;
  end if;

  -- Ending a call suppresses every unfinished consult created by that call.
  -- Completed business side effects remain canonical and are not reversed.
  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.conversation_id = p_conversation_id
    and job.status in ('pending', 'processing')
    and exists (
      select 1
      from conversation_messages message
      where message.id = job.triggering_message_id
        and message.conversation_id = p_conversation_id
        and message.author_profile_id = auth.uid()
        and message.metadata->>'realtime_call_id' = p_call_id::text
    );

  duration_seconds := greatest(
    0,
    round(extract(epoch from (coalesce(call_row.ended_at, now()) - call_row.started_at)))::integer
  );
  record_body := coalesce(
    effective_summary,
    format('Call ended after %s min.', greatest(1, round(duration_seconds / 60.0)::integer))
  );
  record_metadata := jsonb_build_object(
    'call_id', call_row.id,
    'duration_seconds', duration_seconds,
    'presentation', call_row.presentation
  );
  if call_row.metadata ? 'realtime_voice_latency' then
    record_metadata := record_metadata || jsonb_build_object(
      'realtime_voice_latency', call_row.metadata->'realtime_voice_latency'
    );
  end if;

  if not exists (
    select 1
    from conversation_messages message
    where message.kind = 'call_record'
      and message.conversation_id = p_conversation_id
      and message.metadata->>'call_id' = call_row.id::text
  ) then
    insert into conversation_messages (
      conversation_id,
      author_profile_id,
      kind,
      body,
      metadata
    ) values (
      p_conversation_id,
      auth.uid(),
      'call_record',
      record_body,
      record_metadata
    );
  else
    update conversation_messages message
    set body = record_body, metadata = record_metadata
    where message.kind = 'call_record'
      and message.conversation_id = p_conversation_id
      and message.metadata->>'call_id' = call_row.id::text;
  end if;

  return call_row;
end;
$$;

revoke all on function end_conversation_call_idempotent(uuid, uuid, text, jsonb) from public, anon;
grant execute on function end_conversation_call_idempotent(uuid, uuid, text, jsonb) to authenticated;

comment on column conversation_calls.client_call_id is
  'Stable device-generated call start intent. Reusing it returns the same canonical call after a lost HTTP response.';
comment on function create_conversation_call_idempotent(uuid, text, uuid) is
  'Starts or recovers one canonical call for one authenticated device intent.';
comment on function end_conversation_call_idempotent(uuid, uuid, text, jsonb) is
  'Ends a call and writes exactly one same-thread call record in the same transaction; safe to retry.';

create or replace function create_conversation_message_idempotent(
  p_conversation_id uuid,
  p_body text,
  p_metadata jsonb,
  p_client_message_id uuid,
  p_attachment_ids uuid[]
)
returns conversation_messages
language plpgsql
security definer
set search_path = public
as $$
declare
  created_message conversation_messages;
  requested_count integer;
  valid_count integer;
  attached_count integer;
  bound_count integer;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  if p_client_message_id is null then
    raise exception 'client message id is required';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 20000 then
    raise exception 'message body is invalid';
  end if;

  if p_metadata is not null and jsonb_typeof(p_metadata) <> 'object' then
    raise exception 'message metadata must be an object';
  end if;
  if pg_column_size(coalesce(p_metadata, '{}'::jsonb)) > 8192 then
    raise exception 'message metadata is too large';
  end if;
  if coalesce(p_metadata, '{}'::jsonb) ? 'target_agent_slugs' then
    if jsonb_typeof(p_metadata->'target_agent_slugs') <> 'array' then
      raise exception 'message agent targets are invalid';
    end if;
    if jsonb_array_length(p_metadata->'target_agent_slugs') > 2 then
      raise exception 'message agent targets are invalid';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(p_metadata->'target_agent_slugs') as targets(value)
      where jsonb_typeof(value) <> 'string'
        or value #>> '{}' not in ('aria', 'marco')
    ) then
      raise exception 'message agent targets are invalid';
    end if;
    if (
      select count(*)
      from jsonb_array_elements_text(p_metadata->'target_agent_slugs') as targets(value)
    ) <> (
      select count(distinct value)
      from jsonb_array_elements_text(p_metadata->'target_agent_slugs') as targets(value)
    ) then
      raise exception 'message agent targets are invalid';
    end if;
  end if;

  requested_count := coalesce(cardinality(p_attachment_ids), 0);
  if requested_count not between 0 and 6 then
    raise exception 'attach no more than 6 files';
  end if;

  -- Serialise retries for this user/send intent. This makes the existing-row
  -- check and any attachment binding one atomic idempotent operation.
  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':' || p_client_message_id::text, 0)
  );

  select * into created_message
  from conversation_messages message
  where message.author_profile_id = auth.uid()
    and message.client_message_id = p_client_message_id;

  if found then
    if created_message.conversation_id <> p_conversation_id
      or created_message.body <> btrim(p_body)
      or created_message.metadata <> coalesce(p_metadata, '{}'::jsonb) then
      raise exception 'client message id was already used for different content';
    end if;

    select
      count(*),
      count(*) filter (
        where attachment.id = any(coalesce(p_attachment_ids, array[]::uuid[]))
      )
    into bound_count, attached_count
    from conversation_attachments attachment
    where attachment.message_id = created_message.id;
    if bound_count <> requested_count or attached_count <> requested_count then
      raise exception 'client message id attachment set does not match';
    end if;

    return created_message;
  end if;

  if requested_count > 0 then
    select count(*) into valid_count
    from conversation_attachments attachment
    where attachment.id = any(p_attachment_ids)
      and attachment.conversation_id = p_conversation_id
      and attachment.uploaded_by = auth.uid()
      and attachment.message_id is null
      and attachment.status = 'ready';

    -- A duplicate id in the input array also fails this equality check.
    if valid_count <> requested_count then
      raise exception 'one or more attachments are unavailable';
    end if;
  end if;

  insert into conversation_messages (
    conversation_id,
    author_profile_id,
    body,
    metadata,
    client_message_id
  ) values (
    p_conversation_id,
    auth.uid(),
    btrim(p_body),
    coalesce(p_metadata, '{}'::jsonb),
    p_client_message_id
  )
  returning * into created_message;

  if requested_count > 0 then
    update conversation_attachments
    set message_id = created_message.id
    where id = any(p_attachment_ids)
      and message_id is null;
    get diagnostics attached_count = row_count;

    if attached_count <> requested_count then
      raise exception 'attachments changed while the message was sending';
    end if;
  end if;

  return created_message;
end;
$$;

revoke all on function create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[])
  from public, anon;
grant execute on function create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[])
  to authenticated;

-- Direct Supabase clients may use the temporary compatibility upsert while
-- Vercel and migrations roll out in either order. Limit it to a job for the
-- caller's own message and an agent who actually belongs to that thread.
drop policy if exists "members_send_messages" on conversation_messages;
create policy "members_send_messages" on conversation_messages
  for insert to authenticated
  with check (
    is_conversation_member(conversation_id)
    and author_profile_id = auth.uid()
    and author_agent_id is null
    and kind = 'text'
    and jsonb_typeof(metadata) = 'object'
    and pg_column_size(metadata) <= 8192
    and case
      when not (metadata ? 'target_agent_slugs') then true
      when jsonb_typeof(metadata->'target_agent_slugs') <> 'array' then false
      when jsonb_array_length(metadata->'target_agent_slugs') > 2 then false
      else not exists (
        select 1
        from jsonb_array_elements(metadata->'target_agent_slugs') target(value)
        where jsonb_typeof(value) <> 'string'
          or value #>> '{}' not in ('aria', 'marco')
      )
    end
    and reply_to_id is null
  );

drop policy if exists "members_create_agent_jobs" on agent_conversation_jobs;
create policy "members_create_agent_jobs" on agent_conversation_jobs
  for insert to authenticated
  with check (
    is_conversation_member(conversation_id)
    and exists (
      select 1
      from conversation_messages message
      where message.id = triggering_message_id
        and message.conversation_id = agent_conversation_jobs.conversation_id
        and message.author_profile_id = auth.uid()
        and message.deleted_at is null
    )
    and exists (
      select 1
      from conversation_participants participant
      where participant.conversation_id = agent_conversation_jobs.conversation_id
        and participant.agent_id = agent_conversation_jobs.agent_id
    )
  );

create or replace function cancel_agent_conversation_jobs(p_conversation_id uuid, p_agent_ids uuid[])
returns integer language plpgsql security definer set search_path = public as $$
declare
  affected integer;
begin
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.conversation_id = p_conversation_id
    and job.agent_id = any(p_agent_ids)
    and job.status in ('pending','processing')
    and exists (
      select 1
      from conversation_messages message
      where message.id = job.triggering_message_id
        and message.conversation_id = p_conversation_id
        and message.author_profile_id = auth.uid()
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function cancel_agent_conversation_jobs(uuid, uuid[]) from public, anon;
grant execute on function cancel_agent_conversation_jobs(uuid, uuid[]) to authenticated;

create or replace function cancel_realtime_conversation_job(
  p_conversation_id uuid,
  p_tool_call_id text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  if not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  update agent_conversation_jobs job
  set status = 'cancelled', completed_at = now()
  where job.conversation_id = p_conversation_id
    and job.status in ('pending', 'processing')
    and exists (
      select 1
      from conversation_messages message
      where message.id = job.triggering_message_id
        and message.conversation_id = p_conversation_id
        and message.author_profile_id = auth.uid()
        and message.metadata->>'realtime_tool_call_id' = p_tool_call_id
    );
  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function cancel_realtime_conversation_job(uuid, text) from public, anon;
grant execute on function cancel_realtime_conversation_job(uuid, text) to authenticated;

drop policy if exists "members_read_conversation_attachments" on conversation_attachments;
create policy "members_read_conversation_attachments"
  on conversation_attachments for select to authenticated
  using (
    is_conversation_member(conversation_id)
    and (message_id is not null or uploaded_by = auth.uid())
  );

comment on column conversation_messages.client_message_id is
  'Device-generated idempotency key. A retry returns the original canonical user message instead of creating a duplicate turn or agent job.';
comment on policy "members_create_agent_jobs" on agent_conversation_jobs is
  'Compatibility inserts may queue only the caller''s own canonical message for an agent participating in the same conversation.';
comment on policy "members_send_messages" on conversation_messages is
  'Compatibility inserts may create only bounded text rows for auth.uid(); canonical call, meeting, system and agent rows remain trusted writes.';
comment on policy "members_read_conversation_attachments" on conversation_attachments is
  'Conversation members can read bound message files; an unbound draft remains private to its uploader.';

notify pgrst, 'reload schema';
