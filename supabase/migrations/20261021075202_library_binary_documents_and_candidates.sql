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
