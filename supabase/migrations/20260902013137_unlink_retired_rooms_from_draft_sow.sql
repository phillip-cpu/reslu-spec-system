-- Follow-up for environments where the room/SOW sync trigger was installed
-- before retired rooms were unlinked from editable scope. Authored content is
-- preserved; only the structural room link is cleared.
create or replace function public.sync_ffe_room_to_draft_sow_sections()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.deleted_at is not null or coalesce(btrim(new.name), '') = '' then
    update public.sow_sections as section
    set source_room_id = null
    from public.sow_documents as sow
    where section.sow_id = sow.id
      and sow.project_id = new.project_id
      and sow.status = 'draft'
      and sow.deleted_at is null
      and section.source_room_id = new.id;

    return new;
  end if;

  update public.sow_sections as section
  set source_room_id = new.id
  from public.sow_documents as sow
  where section.sow_id = sow.id
    and sow.project_id = new.project_id
    and sow.status = 'draft'
    and sow.deleted_at is null
    and section.source_room_id is null
    and lower(btrim(section.heading)) = lower(btrim(new.name))
    and section.id = (
      select candidate.id
      from public.sow_sections as candidate
      where candidate.sow_id = section.sow_id
        and candidate.source_room_id is null
        and lower(btrim(candidate.heading)) = lower(btrim(new.name))
      order by candidate.sort, candidate.id
      limit 1
    )
    and not exists (
      select 1
      from public.sow_sections as linked
      where linked.sow_id = section.sow_id
        and linked.source_room_id = new.id
    );

  insert into public.sow_sections (sow_id, heading, sort, source_room_id)
  select
    sow.id,
    btrim(new.name),
    coalesce((
      select max(existing.sort)
      from public.sow_sections as existing
      where existing.sow_id = sow.id
    ), 0) + 1,
    new.id
  from public.sow_documents as sow
  where sow.project_id = new.project_id
    and sow.status = 'draft'
    and sow.deleted_at is null
  on conflict (sow_id, source_room_id) where source_room_id is not null
  do update set heading = excluded.heading;

  return new;
end;
$$;

revoke all on function public.sync_ffe_room_to_draft_sow_sections() from public;
revoke all on function public.sync_ffe_room_to_draft_sow_sections() from anon;
revoke all on function public.sync_ffe_room_to_draft_sow_sections() from authenticated;
