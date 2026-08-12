-- Private, bounded voice notes reuse the canonical conversation attachment
-- pipeline. Audio is accepted only with explicit bounded-duration metadata
-- and remains governed by the same member-scoped attachment RLS.

create or replace function valid_conversation_voice_note_metadata(
  p_mime_type text,
  p_metadata jsonb
)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  duration_ms integer;
begin
  if p_mime_type not in ('audio/mp4', 'audio/webm') then
    return coalesce(p_metadata->>'voice_note', 'false') <> 'true';
  end if;
  if coalesce(p_metadata->>'voice_note', 'false') <> 'true'
     or jsonb_typeof(p_metadata->'duration_ms') <> 'number'
     or (p_metadata->>'duration_ms') !~ '^[0-9]+$' then
    return false;
  end if;
  begin
    duration_ms := (p_metadata->>'duration_ms')::integer;
  exception when others then
    return false;
  end;
  if duration_ms not between 250 and 300000 then return false; end if;
  return true;
end;
$$;

alter table conversation_attachments
  drop constraint if exists conversation_attachments_mime_type_check;
alter table conversation_attachments
  add constraint conversation_attachments_mime_type_check check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'audio/mp4', 'audio/webm'
  ));
alter table conversation_attachments
  drop constraint if exists conversation_attachments_voice_note_metadata_check;
alter table conversation_attachments
  add constraint conversation_attachments_voice_note_metadata_check check (
    valid_conversation_voice_note_metadata(mime_type, metadata)
  );

alter table conversation_forwarded_attachments
  drop constraint if exists conversation_forwarded_attachments_mime_type_check;
alter table conversation_forwarded_attachments
  add constraint conversation_forwarded_attachments_mime_type_check check (mime_type in (
    'image/jpeg', 'image/png', 'image/webp', 'application/pdf',
    'audio/mp4', 'audio/webm'
  ));
alter table conversation_forwarded_attachments
  drop constraint if exists conversation_forwarded_attachments_voice_note_metadata_check;
alter table conversation_forwarded_attachments
  add constraint conversation_forwarded_attachments_voice_note_metadata_check check (
    valid_conversation_voice_note_metadata(mime_type, metadata)
  );

revoke all on function valid_conversation_voice_note_metadata(text, jsonb)
  from public, anon, authenticated;

comment on function valid_conversation_voice_note_metadata(text, jsonb) is
  'Fail-closed metadata contract for private five-minute voice notes.';
comment on table conversation_attachments is
  'Private photo/PDF/voice-note context attached to canonical RESLU conversation messages. Staged rows have no message_id; send binds them atomically.';

notify pgrst, 'reload schema';
