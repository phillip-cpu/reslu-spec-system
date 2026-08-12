-- Stuart's finance memory is visible only to administrator profiles.
-- Marco and all other Second Brain sources retain normal team visibility.

create or replace function public.current_profile_is_admin()
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

revoke all on function public.current_profile_is_admin() from public;
grant execute on function public.current_profile_is_admin() to authenticated, service_role;

-- This helper executes as its owner so workspace_index RLS can identify a
-- Stuart memory without depending on the caller being able to read that
-- protected brain_notes row first.
create or replace function public.can_access_brain_memory(memory_id uuid)
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
    or public.current_profile_is_admin();
$$;

revoke all on function public.can_access_brain_memory(uuid) from public;
grant execute on function public.can_access_brain_memory(uuid) to authenticated, service_role;

drop policy if exists "team_all" on public.brain_notes;
drop policy if exists "brain_notes_team_select" on public.brain_notes;
drop policy if exists "brain_notes_team_insert" on public.brain_notes;
drop policy if exists "brain_notes_team_update" on public.brain_notes;
drop policy if exists "brain_notes_team_delete" on public.brain_notes;

create policy "brain_notes_team_select" on public.brain_notes
  for select to authenticated
  using (lower(trim(source)) <> 'stuart' or public.current_profile_is_admin());

create policy "brain_notes_team_insert" on public.brain_notes
  for insert to authenticated
  with check (lower(trim(source)) <> 'stuart' or public.current_profile_is_admin());

create policy "brain_notes_team_update" on public.brain_notes
  for update to authenticated
  using (lower(trim(source)) <> 'stuart' or public.current_profile_is_admin())
  with check (lower(trim(source)) <> 'stuart' or public.current_profile_is_admin());

create policy "brain_notes_team_delete" on public.brain_notes
  for delete to authenticated
  using (lower(trim(source)) <> 'stuart' or public.current_profile_is_admin());

-- Search rows contain the full note body, so the semantic index needs the
-- same boundary as brain_notes itself.
drop policy if exists "team_all" on public.workspace_index;
drop policy if exists "workspace_index_team_all" on public.workspace_index;

create policy "workspace_index_team_all" on public.workspace_index
  for all to authenticated
  using (
    entity_type <> 'memory'
    or public.can_access_brain_memory(entity_id)
  )
  with check (
    entity_type <> 'memory'
    or public.can_access_brain_memory(entity_id)
  );

comment on function public.current_profile_is_admin() is
  'RLS helper for administrator-only Stuart finance memory.';

comment on function public.can_access_brain_memory(uuid) is
  'Returns false for Stuart-owned finance memory unless the signed-in profile is an administrator.';

notify pgrst, 'reload schema';
