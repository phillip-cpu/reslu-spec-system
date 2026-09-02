-- Keep editable SOW structure aligned with the current FF&E room register.
-- A room is working project structure, so creating or renaming it is an R1
-- operation and must not require a second manual SOW-builder action.

alter table public.sow_sections
  add column if not exists source_room_id uuid references public.rooms(id) on delete set null;

create unique index if not exists uq_sow_sections_source_room
  on public.sow_sections (sow_id, source_room_id)
  where source_room_id is not null;

-- The composite uniqueness index starts with sow_id, so it cannot
-- efficiently service the FK's ON DELETE SET NULL lookup by room id.
create index if not exists idx_sow_sections_source_room
  on public.sow_sections (source_room_id)
  where source_room_id is not null;

create or replace function public.sync_ffe_room_to_draft_sow_sections()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Retiring a room never destroys authored SOW content. Unlink it from each
  -- editable SOW so the preserved section becomes ordinary authored scope.
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

  -- Adopt an existing same-named section before inserting anything. This
  -- makes the migration and retries idempotent and preserves authored lines.
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

drop trigger if exists trg_rooms_sync_draft_sow_sections on public.rooms;
create trigger trg_rooms_sync_draft_sow_sections
after insert or update of name, deleted_at on public.rooms
for each row
execute function public.sync_ffe_room_to_draft_sow_sections();

-- Link existing same-named draft sections to their FF&E rooms first.
update public.sow_sections as section
set source_room_id = room.id
from public.sow_documents as sow, public.rooms as room
where section.sow_id = sow.id
  and room.project_id = sow.project_id
  and sow.status = 'draft'
  and sow.deleted_at is null
  and room.deleted_at is null
  and section.source_room_id is null
  and lower(btrim(section.heading)) = lower(btrim(room.name))
  and room.id = (
    select candidate_room.id
    from public.rooms as candidate_room
    where candidate_room.project_id = room.project_id
      and candidate_room.deleted_at is null
      and lower(btrim(candidate_room.name)) = lower(btrim(room.name))
    order by candidate_room.sort, candidate_room.id
    limit 1
  )
  and section.id = (
    select candidate_section.id
    from public.sow_sections as candidate_section
    where candidate_section.sow_id = section.sow_id
      and candidate_section.source_room_id is null
      and lower(btrim(candidate_section.heading)) = lower(btrim(room.name))
    order by candidate_section.sort, candidate_section.id
    limit 1
  )
  and not exists (
    select 1
    from public.sow_sections as linked
    where linked.sow_id = section.sow_id
      and linked.source_room_id = room.id
  );

-- Backfill every active FF&E room that is still absent from an editable SOW.
insert into public.sow_sections (sow_id, heading, sort, source_room_id)
select
  sow.id,
  btrim(room.name),
  coalesce((
    select max(existing.sort)
    from public.sow_sections as existing
    where existing.sow_id = sow.id
  ), 0) + row_number() over (partition by sow.id order by room.sort, room.name),
  room.id
from public.sow_documents as sow
join public.rooms as room on room.project_id = sow.project_id
where sow.status = 'draft'
  and sow.deleted_at is null
  and room.deleted_at is null
  and btrim(room.name) <> ''
  and not exists (
    select 1
    from public.sow_sections as linked
    where linked.sow_id = sow.id
      and linked.source_room_id = room.id
  )
on conflict (sow_id, source_room_id) where source_room_id is not null
do nothing;

comment on column public.sow_sections.source_room_id is
  'FF&E room mirrored into this editable SOW section; nullable for non-room/custom sections.';
