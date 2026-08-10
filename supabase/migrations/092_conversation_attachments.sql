-- Canonical private attachments for RESLU staff/agent conversations.
-- Bytes live in the existing private `assets` bucket. Rows are staged before
-- send, then bound atomically to one canonical conversation message.

create table if not exists conversation_attachments (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id      uuid references conversation_messages(id) on delete cascade,
  uploaded_by     uuid not null references profiles(id),
  storage_path    text not null unique,
  filename        text not null check (char_length(filename) between 1 and 255),
  mime_type       text not null check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  )),
  byte_size       bigint not null check (byte_size between 1 and 26214400),
  status          text not null default 'uploading' check (status in ('uploading', 'ready', 'failed')),
  metadata        jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now(),
  ready_at        timestamptz
);

create index if not exists conversation_attachments_message_idx
  on conversation_attachments(message_id) where message_id is not null;
create index if not exists conversation_attachments_staged_idx
  on conversation_attachments(uploaded_by, created_at) where message_id is null;

alter table conversation_attachments enable row level security;

create policy "members_read_conversation_attachments"
  on conversation_attachments for select to authenticated
  using (is_conversation_member(conversation_id));

create policy "members_stage_own_conversation_attachments"
  on conversation_attachments for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and message_id is null
    and is_conversation_member(conversation_id)
  );

create policy "uploaders_finalize_own_staged_attachments"
  on conversation_attachments for update to authenticated
  using (
    uploaded_by = auth.uid()
    and message_id is null
    and is_conversation_member(conversation_id)
  )
  with check (
    uploaded_by = auth.uid()
    and message_id is null
    and is_conversation_member(conversation_id)
  );

create policy "uploaders_delete_own_staged_attachments"
  on conversation_attachments for delete to authenticated
  using (
    uploaded_by = auth.uid()
    and message_id is null
    and is_conversation_member(conversation_id)
  );

create or replace function create_conversation_message_with_attachments(
  p_conversation_id uuid,
  p_body text,
  p_metadata jsonb,
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
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;

  if char_length(btrim(coalesce(p_body, ''))) not between 1 and 20000 then
    raise exception 'message body is invalid';
  end if;

  requested_count := coalesce(cardinality(p_attachment_ids), 0);
  if requested_count not between 1 and 6 then
    raise exception 'attach between 1 and 6 files';
  end if;

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

  insert into conversation_messages (
    conversation_id,
    author_profile_id,
    body,
    metadata
  ) values (
    p_conversation_id,
    auth.uid(),
    btrim(p_body),
    coalesce(p_metadata, '{}'::jsonb)
  )
  returning * into created_message;

  update conversation_attachments
  set message_id = created_message.id
  where id = any(p_attachment_ids)
    and message_id is null;
  get diagnostics attached_count = row_count;

  if attached_count <> requested_count then
    raise exception 'attachments changed while the message was sending';
  end if;

  return created_message;
end;
$$;

revoke all on function create_conversation_message_with_attachments(uuid, text, jsonb, uuid[])
  from public, anon;
grant execute on function create_conversation_message_with_attachments(uuid, text, jsonb, uuid[])
  to authenticated;

comment on table conversation_attachments is
  'Private photo/PDF context attached to canonical RESLU conversation messages. Staged rows have no message_id; send binds them atomically.';

notify pgrst, 'reload schema';
