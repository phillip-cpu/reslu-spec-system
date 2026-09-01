-- Phase names are user-facing identifiers across Work and Timeline. The API
-- blocks duplicate normalized names, but that read-then-write check alone is
-- vulnerable to two concurrent requests. Serialize name writes per project
-- and reject new duplicates at the database boundary. Historical duplicates
-- remain readable and can be repaired by renaming either row to a unique name.

create or replace function prevent_duplicate_board_group_name()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  normalized_name text := lower(regexp_replace(btrim(new.name), '\s+', ' ', 'g'));
begin
  perform pg_advisory_xact_lock(
    hashtextextended('board-group-name:' || new.project_id::text, 0)
  );

  if exists (
    select 1
    from board_groups sibling
    where sibling.project_id = new.project_id
      and sibling.id <> new.id
      and lower(regexp_replace(btrim(sibling.name), '\s+', ' ', 'g')) = normalized_name
  ) then
    raise exception using
      errcode = '23505',
      message = format('A phase named “%s” already exists', btrim(new.name));
  end if;

  return new;
end;
$$;

revoke all on function prevent_duplicate_board_group_name()
  from public, anon, authenticated;

drop trigger if exists trg_prevent_duplicate_board_group_name on board_groups;
create trigger trg_prevent_duplicate_board_group_name
  before insert or update of project_id, name on board_groups
  for each row execute function prevent_duplicate_board_group_name();

comment on function prevent_duplicate_board_group_name() is
  'Serializes phase-name writes per project and rejects new normalized duplicate board-group names.';
