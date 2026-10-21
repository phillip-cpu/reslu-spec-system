alter table public.library_product_documents drop constraint library_product_documents_kind_check;
alter table public.library_product_documents add constraint library_product_documents_kind_check check(kind in ('spec_sheet','install_manual','technical_drawing','cutout_template'));
-- Private assets bucket and its existing team policies remain unchanged.
alter table public.library_product_documents
 add column storage_path text,
 add column filename text,
 add column mime_type text,
 add column size_bytes bigint check(size_bytes > 0 and size_bytes <= 26214400),
 add column sha256 text check(sha256 ~ '^[a-f0-9]{64}$'),
 add column verified_on date,
 add column verification jsonb not null default '{}'::jsonb;
alter table public.library_product_documents drop constraint if exists library_product_documents_library_item_id_kind_url_key;
create unique index library_document_content_identity on public.library_product_documents(library_item_id,kind,sha256) where sha256 is not null;
alter table public.library_product_documents add constraint library_document_binary_metadata check (
 (storage_path is null and sha256 is null) or
 (storage_path like 'library/' || library_item_id::text || '/documents/%' and filename is not null and mime_type in ('application/pdf','image/jpeg','image/png','image/webp') and size_bytes is not null and sha256 is not null)
);
-- Unknown quantities are candidates, NOT costable/orderable items. No zero sentinel.
create table public.project_library_candidates (
 id uuid primary key default gen_random_uuid(),
 project_id uuid not null references public.projects(id) on delete restrict,
 library_item_id uuid not null references public.library_items(id) on delete restrict,
 selection_scope text not null default 'shared' check(selection_scope ~ '^[a-z0-9_-]{1,64}$'),
 selection_key text check(selection_key is null or length(trim(selection_key)) between 1 and 120),
 created_at timestamptz not null default now(),
 unique(project_id,library_item_id,selection_scope)
);
alter table public.project_library_candidates enable row level security;
revoke all on public.project_library_candidates from public,anon,authenticated;
grant select,insert,update,delete on public.project_library_candidates to authenticated;
grant all on public.project_library_candidates to service_role;
create policy team_all on public.project_library_candidates for all to authenticated using((select auth.uid()) is not null) with check((select auth.uid()) is not null);
