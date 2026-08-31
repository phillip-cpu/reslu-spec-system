create index if not exists idx_supplier_quote_attachments_package
  on public.supplier_quote_attachments(package_id);
create index if not exists idx_supplier_quote_attachments_request
  on public.supplier_quote_attachments(request_id)
  where request_id is not null;
create index if not exists idx_supplier_quote_attachments_uploaded_by
  on public.supplier_quote_attachments(uploaded_by)
  where uploaded_by is not null;
create index if not exists idx_supplier_quote_packages_created_by
  on public.supplier_quote_packages(created_by)
  where created_by is not null;
create index if not exists idx_supplier_quote_requests_contact
  on public.supplier_quote_requests(contact_id)
  where contact_id is not null;
create index if not exists idx_supplier_quote_requests_created_by
  on public.supplier_quote_requests(created_by)
  where created_by is not null;
create index if not exists idx_supplier_quote_response_lines_package_line
  on public.supplier_quote_response_lines(package_line_id);
