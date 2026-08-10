-- Bounded, member-scoped full-history text search. The trigram index keeps
-- substring search responsive as canonical RESLU conversation history grows.

create extension if not exists pg_trgm;

create index if not exists conversation_messages_body_trgm_idx
  on conversation_messages using gin (body gin_trgm_ops)
  where deleted_at is null;

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
    and message.body ilike '%' || escaped_query || '%' escape E'\\'
  order by message.created_at desc, message.id desc
  limit p_limit;
end;
$$;

revoke all on function search_conversation_messages(uuid, text, integer) from public, anon;
grant execute on function search_conversation_messages(uuid, text, integer) to authenticated;

comment on function search_conversation_messages(uuid, text, integer) is
  'Member-scoped canonical conversation substring search. Wildcards are treated literally and results are bounded to 50.';

notify pgrst, 'reload schema';
