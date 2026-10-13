-- SEPARATE PROPOSAL ONLY: NOT a migration, NOT applied to production.
-- Minimal role-change guard; keep legitimate existing profile edits and trusted
-- maintenance. Does not add any new profile UPDATE policy or admin capability.
create schema if not exists profile_security_private;
revoke all on schema profile_security_private from public, anon, authenticated;
create function profile_security_private.guard_profile_role_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  requested_role text := current_setting('role',true);
  actor uuid := auth.uid();
begin
  if new.role is not distinct from old.role then return new; end if;
  -- current_user is the function owner here; do NOT use it to detect service access.
  if requested_role in ('service_role','postgres','supabase_admin')
     or (coalesce(requested_role,'none') in ('none','') and session_user in ('postgres','supabase_admin')) then
    return new;
  end if;
  if actor is null or not exists (select 1 from public.profiles where id=actor and role='admin') then
    raise exception 'Only an existing administrator may change profile roles' using errcode='42501';
  end if;
  return new;
end;
$$;
revoke all on function profile_security_private.guard_profile_role_change() from public,anon,authenticated;
create trigger guard_profile_role_change before update of role on public.profiles
for each row execute function profile_security_private.guard_profile_role_change();
