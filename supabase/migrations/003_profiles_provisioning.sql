-- ============================================================
-- RESLU Spec System — Auto-provision profiles for auth users
-- ============================================================
-- Gap in 001: `items.created_by`, `item_files.uploaded_by`, etc.
-- reference profiles(id), but nothing created a profiles row when an
-- admin adds a team member via Supabase Auth. Result: the first time
-- someone tries to create an item the insert fails with
--   "violates foreign key constraint items_created_by_fkey".
--
-- Fix: mirror every auth user into public.profiles on signup (the
-- standard Supabase pattern), and backfill anyone who already exists.
-- Run once in the SQL Editor. Idempotent.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', split_part(new.email, '@', 1)),
    new.email
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill users that already exist.
insert into public.profiles (id, full_name, email)
select
  u.id,
  coalesce(u.raw_user_meta_data->>'full_name', split_part(u.email, '@', 1)),
  u.email
from auth.users u
on conflict (id) do nothing;
