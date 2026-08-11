-- Exactly-once forwarding for canonical conversation messages. A forwarded
-- attachment is a member-scoped reference to the same private storage object;
-- the original unique storage row is never duplicated or exposed.

create table if not exists conversation_forwarded_attachments (
  id                             uuid primary key default gen_random_uuid(),
  conversation_id                uuid not null references conversations(id) on delete cascade,
  message_id                     uuid not null references conversation_messages(id) on delete cascade,
  source_attachment_id           uuid references conversation_attachments(id) on delete set null,
  source_forwarded_attachment_id uuid references conversation_forwarded_attachments(id) on delete set null,
  forwarded_by                   uuid not null references profiles(id),
  storage_path                   text not null,
  filename                       text not null check (char_length(filename) between 1 and 255),
  mime_type                      text not null check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf'
  )),
  byte_size                      bigint not null check (byte_size between 1 and 26214400),
  metadata                       jsonb not null default '{}'::jsonb,
  created_at                     timestamptz not null default now(),
  check (num_nonnulls(source_attachment_id, source_forwarded_attachment_id) <= 1),
  unique (message_id, storage_path)
);

create index if not exists conversation_forwarded_attachments_message_idx
  on conversation_forwarded_attachments(message_id, created_at);

create table if not exists conversation_message_forwards (
  id                          uuid primary key default gen_random_uuid(),
  forwarded_by                uuid not null references profiles(id),
  client_forward_id           uuid not null,
  source_conversation_id      uuid not null,
  source_message_id           uuid not null,
  destination_conversation_id uuid not null,
  forwarded_message_id        uuid not null references conversation_messages(id) on delete cascade,
  created_at                  timestamptz not null default now(),
  unique (forwarded_by, client_forward_id, destination_conversation_id),
  unique (forwarded_message_id)
);

create index if not exists conversation_message_forwards_source_idx
  on conversation_message_forwards(source_message_id, created_at);

alter table conversation_forwarded_attachments enable row level security;
alter table conversation_message_forwards enable row level security;

drop policy if exists "members_read_forwarded_attachments" on conversation_forwarded_attachments;
create policy "members_read_forwarded_attachments"
  on conversation_forwarded_attachments
  for select to authenticated
  using (is_conversation_member(conversation_id));

drop policy if exists "forwarders_read_own_forward_audit" on conversation_message_forwards;
create policy "forwarders_read_own_forward_audit"
  on conversation_message_forwards
  for select to authenticated
  using (
    forwarded_by = auth.uid()
    and is_conversation_member(destination_conversation_id)
  );

create or replace function forward_conversation_message(
  p_source_conversation_id uuid,
  p_source_message_id uuid,
  p_destination_conversation_ids uuid[],
  p_client_forward_id uuid
)
returns table (
  destination_conversation_id uuid,
  forwarded_message_id uuid,
  existing boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  source_message conversation_messages%rowtype;
  destination_id uuid;
  created_message conversation_messages%rowtype;
  destination_count integer;
  existing_count integer;
  source_attachment_count integer;
begin
  if auth.uid() is null
    or p_source_conversation_id is null
    or p_source_message_id is null
    or p_client_forward_id is null then
    raise exception 'unauthorized';
  end if;

  destination_count := coalesce(cardinality(p_destination_conversation_ids), 0);
  if destination_count not between 1 and 10
    or exists (select 1 from unnest(p_destination_conversation_ids) item where item is null)
    or destination_count <> (
      select count(distinct item) from unnest(p_destination_conversation_ids) item
    ) then
    raise exception 'choose between 1 and 10 unique destination conversations';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(auth.uid()::text || ':message-forward:' || p_client_forward_id::text, 0)
  );

  select count(*) into existing_count
  from conversation_message_forwards audit
  where audit.forwarded_by = auth.uid()
    and audit.client_forward_id = p_client_forward_id;

  if existing_count > 0 then
    if existing_count <> destination_count
      or exists (
        select 1
        from conversation_message_forwards audit
        where audit.forwarded_by = auth.uid()
          and audit.client_forward_id = p_client_forward_id
          and (
            audit.source_conversation_id <> p_source_conversation_id
            or audit.source_message_id <> p_source_message_id
            or not (audit.destination_conversation_id = any(p_destination_conversation_ids))
          )
      )
      or exists (
        select 1
        from unnest(p_destination_conversation_ids) requested(destination_id)
        where not exists (
          select 1
          from conversation_message_forwards audit
          where audit.forwarded_by = auth.uid()
            and audit.client_forward_id = p_client_forward_id
            and audit.destination_conversation_id = requested.destination_id
        )
      ) then
      raise exception 'client forward id was already used for a different request';
    end if;

    return query
    select audit.destination_conversation_id, audit.forwarded_message_id, true
    from conversation_message_forwards audit
    where audit.forwarded_by = auth.uid()
      and audit.client_forward_id = p_client_forward_id
    order by audit.created_at, audit.destination_conversation_id;
    return;
  end if;

  if not is_conversation_member(p_source_conversation_id) then
    raise exception 'source message not found';
  end if;
  if exists (
    select 1
    from unnest(p_destination_conversation_ids) requested(destination_id)
    where not is_conversation_member(requested.destination_id)
  ) then
    raise exception 'destination conversation not found';
  end if;

  select message.* into source_message
  from conversation_messages message
  where message.id = p_source_message_id
    and message.conversation_id = p_source_conversation_id
    and message.kind = 'text'
    and message.deleted_at is null
  for share;
  if not found then
    raise exception 'source message not found';
  end if;

  select count(*) into source_attachment_count
  from (
    select attachment.storage_path
    from conversation_attachments attachment
    where attachment.message_id = p_source_message_id
      and attachment.conversation_id = p_source_conversation_id
      and attachment.status = 'ready'
    union
    select forwarded.storage_path
    from conversation_forwarded_attachments forwarded
    where forwarded.message_id = p_source_message_id
      and forwarded.conversation_id = p_source_conversation_id
  ) source_files;
  if source_attachment_count > 6 then
    raise exception 'source message has too many attachments to forward';
  end if;

  foreach destination_id in array p_destination_conversation_ids loop
    insert into conversation_messages (
      conversation_id,
      author_profile_id,
      kind,
      body,
      metadata,
      client_message_id
    ) values (
      destination_id,
      auth.uid(),
      'text',
      source_message.body,
      jsonb_build_object(
        'source', 'forward',
        'forwarded', true,
        'target_agent_slugs', '[]'::jsonb
      ),
      gen_random_uuid()
    )
    returning * into created_message;

    insert into conversation_forwarded_attachments (
      conversation_id,
      message_id,
      source_attachment_id,
      source_forwarded_attachment_id,
      forwarded_by,
      storage_path,
      filename,
      mime_type,
      byte_size,
      metadata
    )
    select distinct on (source_file.storage_path)
      destination_id,
      created_message.id,
      source_file.source_attachment_id,
      source_file.source_forwarded_attachment_id,
      auth.uid(),
      source_file.storage_path,
      source_file.filename,
      source_file.mime_type,
      source_file.byte_size,
      source_file.metadata || jsonb_build_object('forwarded', true)
    from (
      select
        attachment.id as source_attachment_id,
        null::uuid as source_forwarded_attachment_id,
        attachment.storage_path,
        attachment.filename,
        attachment.mime_type,
        attachment.byte_size,
        attachment.metadata
      from conversation_attachments attachment
      where attachment.message_id = p_source_message_id
        and attachment.conversation_id = p_source_conversation_id
        and attachment.status = 'ready'
      union all
      select
        null::uuid as source_attachment_id,
        forwarded.id as source_forwarded_attachment_id,
        forwarded.storage_path,
        forwarded.filename,
        forwarded.mime_type,
        forwarded.byte_size,
        forwarded.metadata
      from conversation_forwarded_attachments forwarded
      where forwarded.message_id = p_source_message_id
        and forwarded.conversation_id = p_source_conversation_id
    ) source_file
    order by source_file.storage_path;

    insert into conversation_message_forwards (
      forwarded_by,
      client_forward_id,
      source_conversation_id,
      source_message_id,
      destination_conversation_id,
      forwarded_message_id
    ) values (
      auth.uid(),
      p_client_forward_id,
      p_source_conversation_id,
      p_source_message_id,
      destination_id,
      created_message.id
    );

    destination_conversation_id := destination_id;
    forwarded_message_id := created_message.id;
    existing := false;
    return next;
  end loop;
end;
$$;

revoke all on table conversation_forwarded_attachments from public, anon, authenticated;
grant select (
  id,
  conversation_id,
  message_id,
  forwarded_by,
  filename,
  mime_type,
  byte_size,
  metadata,
  created_at
) on table conversation_forwarded_attachments to authenticated;
revoke all on table conversation_message_forwards from public, anon, authenticated;
grant select on table conversation_message_forwards to authenticated;

revoke all on function forward_conversation_message(uuid, uuid, uuid[], uuid)
  from public, anon;
grant execute on function forward_conversation_message(uuid, uuid, uuid[], uuid)
  to authenticated;
grant execute on function forward_conversation_message(uuid, uuid, uuid[], uuid)
  to service_role;

comment on table conversation_forwarded_attachments is
  'Private attachment snapshots shared into a forwarded target message without duplicating or exposing the canonical storage row.';
comment on table conversation_message_forwards is
  'Exactly-once forwarding audit keyed by person, client request and destination conversation.';
comment on function forward_conversation_message(uuid, uuid, uuid[], uuid) is
  'Forwards one live text message to 1–10 member conversations atomically; a retry returns the same canonical target messages.';

notify pgrst, 'reload schema';
