-- Extend canonical conversation search to ready private attachment filenames.
-- Results remain messages, so opening a file match loads the exact surrounding
-- conversation context instead of creating a second search destination.

create index if not exists conversation_attachments_filename_trgm_idx
  on conversation_attachments using gin (filename gin_trgm_ops)
  where status = 'ready' and message_id is not null;

create index if not exists conversation_forwarded_attachments_filename_trgm_idx
  on conversation_forwarded_attachments using gin (filename gin_trgm_ops);

create or replace function search_conversation_messages(
  p_conversation_id uuid,
  p_query text,
  p_limit integer default 50
)
returns setof conversation_messages
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  trimmed_query text := btrim(coalesce(p_query, ''));
  escaped_query text;
begin
  if auth.uid() is null or not is_conversation_member(p_conversation_id) then
    raise exception 'conversation not found';
  end if;
  if char_length(trimmed_query) not between 2 and 100 then
    raise exception 'search must contain between 2 and 100 characters';
  end if;
  if coalesce(p_limit, 0) not between 1 and 50 then
    raise exception 'search limit must be between 1 and 50';
  end if;

  escaped_query := replace(trimmed_query, E'\\', E'\\\\');
  escaped_query := replace(escaped_query, '%', E'\\%');
  escaped_query := replace(escaped_query, '_', E'\\_');

  return query
  select message.*
  from conversation_messages message
  where message.conversation_id = p_conversation_id
    and message.deleted_at is null
    and (
      message.body ilike '%' || escaped_query || '%' escape E'\\'
      or exists (
        select 1
        from conversation_attachments attachment
        where attachment.conversation_id = p_conversation_id
          and attachment.message_id = message.id
          and attachment.status = 'ready'
          and attachment.filename ilike '%' || escaped_query || '%' escape E'\\'
      )
      or exists (
        select 1
        from conversation_forwarded_attachments attachment
        where attachment.conversation_id = p_conversation_id
          and attachment.message_id = message.id
          and attachment.filename ilike '%' || escaped_query || '%' escape E'\\'
      )
    )
  order by message.created_at desc, message.id desc
  limit p_limit;
end;
$$;

revoke all on function search_conversation_messages(uuid, text, integer) from public, anon;
grant execute on function search_conversation_messages(uuid, text, integer) to authenticated;

comment on function search_conversation_messages(uuid, text, integer) is
  'Member-scoped bounded literal search across canonical message text and ready uploaded/forwarded attachment filenames.';

notify pgrst, 'reload schema';
