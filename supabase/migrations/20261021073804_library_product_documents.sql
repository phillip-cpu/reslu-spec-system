-- Product-owned documentation: every job reuses these records; revisions are appended.
create table public.library_product_documents (
 id uuid primary key default gen_random_uuid(),
 library_item_id uuid not null references public.library_items(id) on delete restrict,
 kind text not null check(kind in ('spec_sheet','install_manual','technical_drawing')),
 url text not null check(url ~ '^https://'),
 label text not null check(length(trim(label)) between 1 and 200),
 version_note text check(length(version_note)<=500),
 created_at timestamptz not null default now(),
 unique(library_item_id,kind,url)
);
alter table public.library_product_documents enable row level security;
revoke all on public.library_product_documents from public,anon,authenticated;
grant select,insert on public.library_product_documents to authenticated;
grant all on public.library_product_documents to service_role;
create policy team_read on public.library_product_documents for select to authenticated using((select auth.uid()) is not null);
create policy team_append on public.library_product_documents for insert to authenticated with check((select auth.uid()) is not null);
