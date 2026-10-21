-- Additive builder organisation; existing project/library/portal data is untouched.
create table public.builder_profiles (
 id uuid primary key default gen_random_uuid(),
 slug text not null unique check (slug ~ '^[a-z0-9-]+$'),
 name text not null check (length(trim(name)) between 1 and 160),
 contact_id uuid references public.contacts(id) on delete set null,
 schedule_templates jsonb not null default '[]'::jsonb check (jsonb_typeof(schedule_templates)='array'),
 created_at timestamptz not null default now()
);
create table public.builder_library_selections (
 builder_id uuid not null references public.builder_profiles(id) on delete restrict,
 library_item_id uuid not null references public.library_items(id) on delete restrict,
 relationship text not null default 'standard' check (relationship in ('standard','reference')),
 approval text not null default 'proposed' check (approval in ('proposed','approved')),
 notes text,
 primary key(builder_id,library_item_id),
 check (relationship='standard' or approval='proposed')
);
alter table public.projects add column builder_id uuid references public.builder_profiles(id) on delete restrict;
create index projects_builder_active on public.projects(builder_id) where deleted_at is null;
alter table public.items add column selection_scope text not null default 'shared' check (selection_scope ~ '^[a-z0-9_-]{1,64}$');
alter table public.items add column selection_key text check (selection_key is null or length(trim(selection_key)) between 1 and 120);
-- Same internal team boundary as existing projects/items/library. No anonymous access.
alter table public.builder_profiles enable row level security;
alter table public.builder_library_selections enable row level security;
revoke all on public.builder_profiles,public.builder_library_selections from public,anon,authenticated;
grant select,insert,update,delete on public.builder_profiles,public.builder_library_selections to authenticated;
grant all on public.builder_profiles,public.builder_library_selections to service_role;
create policy team_all on public.builder_profiles for all to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
create policy team_all on public.builder_library_selections for all to authenticated using ((select auth.uid()) is not null) with check ((select auth.uid()) is not null);
