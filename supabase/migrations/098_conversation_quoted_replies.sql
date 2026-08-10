-- Reliable quoted replies. The reply target is part of the same idempotent
-- send intent as the body and attachments, so a retry cannot silently change
-- which canonical message the user answered.

drop function if exists create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[]);

create or replace function create_conversation_message_idempotent(
  p_conversation_id uuid,
  p_body text,
  p_metadata jsonb,
  p_client_message_id uuid,
  p_attachment_ids uuid[],
  p_reply_to_id uuid default null
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
      or created_message.metadata <> coalesce(p_metadata, '{}'::jsonb)
      or created_message.reply_to_id is distinct from p_reply_to_id then
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

  if p_reply_to_id is not null and not exists (
    select 1
    from conversation_messages target
    where target.id = p_reply_to_id
      and target.conversation_id = p_conversation_id
      and target.deleted_at is null
  ) then
    raise exception 'reply target is unavailable';
  end if;

  if requested_count > 0 then
    select count(*) into valid_count
    from conversation_attachments attachment
    where attachment.id = any(p_attachment_ids)
      and attachment.conversation_id = p_conversation_id
      and attachment.uploaded_by = auth.uid()
      and attachment.message_id is null
      and attachment.status = 'ready';

    if valid_count <> requested_count then
      raise exception 'one or more attachments are unavailable';
    end if;
  end if;

  insert into conversation_messages (
    conversation_id,
    author_profile_id,
    body,
    metadata,
    client_message_id,
    reply_to_id
  ) values (
    p_conversation_id,
    auth.uid(),
    btrim(p_body),
    coalesce(p_metadata, '{}'::jsonb),
    p_client_message_id,
    p_reply_to_id
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

revoke all on function create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[], uuid)
  from public, anon;
grant execute on function create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[], uuid)
  to authenticated;

comment on function create_conversation_message_idempotent(uuid, text, jsonb, uuid, uuid[], uuid) is
  'Exactly-once canonical message send with an optional same-conversation quoted reply target. Omitting the final argument remains compatible with clients deployed before migration 098.';

notify pgrst, 'reload schema';
