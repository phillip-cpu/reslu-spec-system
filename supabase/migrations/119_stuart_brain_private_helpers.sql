-- Keep Stuart's RLS helper functions outside PostgREST's exposed public
-- schema. Authenticated users may execute them only as part of database
-- policy evaluation; they are not published as /rest/v1/rpc endpoints.

create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated, service_role;

create or replace function private.current_profile_is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
  );
$$;

revoke all on function private.current_profile_is_admin() from public;
grant execute on function private.current_profile_is_admin() to authenticated, service_role;

create or replace function private.can_access_brain_memory(memory_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    not exists (
      select 1
      from public.brain_notes
      where id = memory_id
        and lower(trim(source)) = 'stuart'
    )
    or private.current_profile_is_admin();
$$;

revoke all on function private.can_access_brain_memory(uuid) from public;
grant execute on function private.can_access_brain_memory(uuid) to authenticated, service_role;

drop policy if exists "brain_notes_team_select" on public.brain_notes;
drop policy if exists "brain_notes_team_insert" on public.brain_notes;
drop policy if exists "brain_notes_team_update" on public.brain_notes;
drop policy if exists "brain_notes_team_delete" on public.brain_notes;

create policy "brain_notes_team_select" on public.brain_notes
  for select to authenticated
  using (lower(trim(source)) <> 'stuart' or private.current_profile_is_admin());

create policy "brain_notes_team_insert" on public.brain_notes
  for insert to authenticated
  with check (lower(trim(source)) <> 'stuart' or private.current_profile_is_admin());

create policy "brain_notes_team_update" on public.brain_notes
  for update to authenticated
  using (lower(trim(source)) <> 'stuart' or private.current_profile_is_admin())
  with check (lower(trim(source)) <> 'stuart' or private.current_profile_is_admin());

create policy "brain_notes_team_delete" on public.brain_notes
  for delete to authenticated
  using (lower(trim(source)) <> 'stuart' or private.current_profile_is_admin());

drop policy if exists "workspace_index_team_all" on public.workspace_index;

create policy "workspace_index_team_all" on public.workspace_index
  for all to authenticated
  using (
    entity_type <> 'memory'
    or private.can_access_brain_memory(entity_id)
  )
  with check (
    entity_type <> 'memory'
    or private.can_access_brain_memory(entity_id)
  );

comment on function private.current_profile_is_admin() is
  'Private RLS helper for administrator-only Stuart finance memory.';

comment on function private.can_access_brain_memory(uuid) is
  'Private RLS helper that hides Stuart-owned finance memory from non-admin profiles.';

drop function if exists public.can_access_brain_memory(uuid);
drop function if exists public.current_profile_is_admin();

notify pgrst, 'reload schema';
